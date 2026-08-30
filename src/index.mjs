import { analyzeIssue } from "./ai.mjs";
import { blockTask, repositoryAllowed, setState } from "./github.mjs";
import { admissionDecision, claimTask } from "./scheduler.mjs";
import { dispatchCodexTask } from "./codex-dispatch.mjs";

const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

async function verifySignature(secret, signature, body) {
  if (!secret || !signature?.startsWith("sha256=")) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const bytes = signature.slice(7).match(/.{2}/g)?.map((hex) => parseInt(hex, 16));
  return bytes ? crypto.subtle.verify("HMAC", key, new Uint8Array(bytes), new TextEncoder().encode(body)) : false;
}

export function readyIssueFromWebhook(event, payload) {
  if (event !== "issues" || payload.action !== "labeled" || payload.label?.name !== "metis:ready") return null;
  const labels = (payload.issue?.labels || []).map((label) => typeof label === "string" ? label : label.name);
  const sizeLabel = labels.find((label) => /^metis:size-(small|medium|large|unknown)$/.test(label));
  const maxCostLabel = labels.find((label) => /^metis:max-cost-\d+$/.test(label));
  return {
    repository: payload.repository?.full_name,
    issue_number: payload.issue?.number,
    issue_node_id: payload.issue?.node_id,
    title: payload.issue?.title || "",
    body: payload.issue?.body || "",
    actor: payload.sender?.login || "unknown",
    size_class: sizeLabel?.slice("metis:size-".length) || null,
    max_cost_units: maxCostLabel ? Number(maxCostLabel.slice("metis:max-cost-".length)) : null,
    budget_approved: labels.includes("metis:budget-approved") ? 1 : 0,
  };
}

async function receiveWebhook(request, env) {
  const body = await request.text();
  if (!await verifySignature(env.GITHUB_WEBHOOK_SECRET, request.headers.get("x-hub-signature-256"), body)) return json({ error: "invalid signature" }, 401);
  const delivery = request.headers.get("x-github-delivery");
  const event = request.headers.get("x-github-event");
  if (event === "ping") return json({ ok: true });
  const task = readyIssueFromWebhook(event, JSON.parse(body));
  if (!task) return json({ accepted: false }, 202);
  if (!repositoryAllowed(env, task.repository)) return json({ error: "repository not allowed" }, 403);
  const id = `${task.repository}#${task.issue_number}`;
  try {
    await env.DB.prepare("INSERT INTO webhook_deliveries (delivery_id, event_name, received_at) VALUES (?, ?, unixepoch())").bind(delivery, event).run();
  } catch (error) {
    if (String(error).includes("UNIQUE")) return json({ accepted: true, duplicate: true }, 202);
    throw error;
  }
  await env.DB.prepare("INSERT INTO tasks (id, repository, issue_number, issue_node_id, title, body, state, actor, size_class, max_cost_units, budget_approved, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'intake', ?, ?, ?, ?, unixepoch(), unixepoch()) ON CONFLICT(id) DO UPDATE SET title=excluded.title, body=excluded.body, state='intake', actor=excluded.actor, size_class=excluded.size_class, max_cost_units=excluded.max_cost_units, budget_approved=excluded.budget_approved, updated_at=unixepoch()")
    .bind(id, task.repository, task.issue_number, task.issue_node_id, task.title, task.body, task.actor, task.size_class, task.max_cost_units, task.budget_approved).run();
  await env.DISPATCH_QUEUE.send({ type: "intake", taskId: id });
  return json({ accepted: true, task_id: id }, 202);
}

async function handleIntake(env, message) {
  const task = await env.DB.prepare("SELECT * FROM tasks WHERE id = ?").bind(message.taskId).first();
  if (!task) return;
  await setState(env, task.repository, task.issue_number, "metis:planning");
  const analysis = await analyzeIssue(env, task);
  await env.DB.prepare("UPDATE tasks SET summary=?, size_class=?, size_confidence=?, estimated_cost_units=?, dependencies_json=?, priority_score=?, state=?, blocker_reason=?, updated_at=unixepoch() WHERE id=?")
    .bind(analysis.summary, task.size_class || analysis.size, analysis.confidence, analysis.estimated_cost_units, JSON.stringify(analysis.dependencies), analysis.priority_score, analysis.readiness, analysis.blocker_question, task.id).run();
  await env.DB.prepare("DELETE FROM dependencies WHERE task_id=?").bind(task.id).run();
  if (analysis.dependencies.length) {
    await env.DB.batch(analysis.dependencies.map((dependency) => env.DB.prepare("INSERT INTO dependencies (task_id, dependency_ref, state) VALUES (?, ?, 'unverified')").bind(task.id, dependency)));
  }
  await env.DB.prepare("INSERT INTO usage_events (task_id, provider, operation, cost_units, metadata_json, created_at) VALUES (?, 'workers_ai', 'issue_analysis', 0, ?, unixepoch())").bind(task.id, JSON.stringify({ model: "workers-ai", size: analysis.size })).run();
  if (analysis.readiness === "blocked") return blockTask(env, task, analysis.status_summary || analysis.summary, analysis.blocker_question || "What information is needed to make this issue executable?");
  await env.DISPATCH_QUEUE.send({ type: "dispatch", taskId: task.id });
}

async function handleDispatch(env, message) {
  const task = await env.DB.prepare("SELECT * FROM tasks WHERE id = ?").bind(message.taskId).first();
  if (!task) return;
  const decision = await admissionDecision(env, task);
  if (!decision.admitted) {
    if (decision.defer) {
      await env.DB.prepare("UPDATE tasks SET state='ready', updated_at=unixepoch() WHERE id=?").bind(task.id).run();
      throw new Error(decision.reason);
    }
    await env.DB.prepare("UPDATE tasks SET state='budget_blocked', blocker_reason=?, updated_at=unixepoch() WHERE id=?").bind(decision.reason, task.id).run();
    return blockTask(env, task, decision.reason, "Should Metis increase this task's budget/capacity or wait for the next capacity window?", true);
  }
  const { leaseId } = await claimTask(env, task, decision);
  await setState(env, task.repository, task.issue_number, "metis:implementing");
  try {
    const dispatch = await dispatchCodexTask(env, { ...task, max_cost_units: task.max_cost_units || decision.estimate }, leaseId);
    await env.DB.prepare("INSERT INTO dispatches (task_id, lease_id, provider, external_id, state, created_at, updated_at) VALUES (?, ?, 'codex_included', ?, 'running', unixepoch(), unixepoch())").bind(task.id, leaseId, dispatch.id).run();
    await env.DB.prepare("UPDATE tasks SET state='running', updated_at=unixepoch() WHERE id=?").bind(task.id).run();
  } catch (error) {
    await env.DB.prepare("DELETE FROM task_leases WHERE task_id=?").bind(task.id).run();
    if (task.attempt_count + 1 >= decision.maxRetries) {
      await env.DB.prepare("UPDATE tasks SET state='blocked', blocker_reason=?, updated_at=unixepoch() WHERE id=?").bind(String(error), task.id).run();
      return blockTask(env, task, "The coding provider could not accept the task within its retry limit.", "Should Metis retry after the provider configuration or capacity is corrected?");
    }
    await env.DB.prepare("UPDATE tasks SET state='retrying', updated_at=unixepoch() WHERE id=?").bind(task.id).run();
    throw error;
  }
}

async function handleCallback(request, env) {
  if (request.headers.get("authorization") !== `Bearer ${env.CODEX_CALLBACK_TOKEN}`) return json({ error: "unauthorized" }, 401);
  const result = await request.json();
  const dispatch = await env.DB.prepare("SELECT * FROM dispatches WHERE external_id=?").bind(result.id).first();
  if (!dispatch) return json({ error: "unknown dispatch" }, 404);
  const task = await env.DB.prepare("SELECT * FROM tasks WHERE id=?").bind(dispatch.task_id).first();
  await env.DB.batch([
    env.DB.prepare("UPDATE dispatches SET state=?, result_json=?, updated_at=unixepoch() WHERE id=?").bind(result.status, JSON.stringify(result), dispatch.id),
    env.DB.prepare("DELETE FROM task_leases WHERE task_id=?").bind(task.id),
    env.DB.prepare("INSERT INTO usage_events (task_id, provider, operation, input_tokens, output_tokens, cost_units, metadata_json, created_at) VALUES (?, 'codex_included', 'coding', ?, ?, ?, ?, unixepoch())").bind(task.id, result.usage?.input_tokens || null, result.usage?.output_tokens || null, result.usage?.cost_units || 0, JSON.stringify(result.usage || {})),
  ]);
  if (result.status === "blocked") {
    await env.DB.prepare("UPDATE tasks SET state='blocked', blocker_reason=?, updated_at=unixepoch() WHERE id=?").bind(result.question || result.summary, task.id).run();
    await blockTask(env, task, result.summary, result.question || "What decision is needed to continue?");
  } else if (result.status === "completed" && result.pull_request_url) {
    await env.DB.prepare("UPDATE tasks SET state='pr_ready', pull_request_url=?, updated_at=unixepoch() WHERE id=?").bind(result.pull_request_url, task.id).run();
    await setState(env, task.repository, task.issue_number, "metis:pr-ready");
  } else {
    await env.DB.prepare("UPDATE tasks SET state='failed', blocker_reason=?, updated_at=unixepoch() WHERE id=?").bind(result.summary || "Coding execution failed", task.id).run();
    await setState(env, task.repository, task.issue_number, "metis:failed");
  }
  return json({ accepted: true });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") return json({ ok: true, service: "metis-control-plane" });
    if (request.method === "POST" && url.pathname === "/webhooks/github") return receiveWebhook(request, env);
    if (request.method === "POST" && url.pathname === "/callbacks/codex") return handleCallback(request, env);
    return json({ error: "not found" }, 404);
  },
  async queue(batch, env) {
    for (const message of batch.messages) {
      try {
        if (message.body.type === "intake") await handleIntake(env, message.body);
        else if (message.body.type === "dispatch") await handleDispatch(env, message.body);
        else throw new Error("Unknown queue message type");
        message.ack();
      } catch (error) {
        console.error("Queue operation failed", { messageId: message.id, error: String(error) });
        message.retry();
      }
    }
  },
  async scheduled(_controller, env) {
    const expired = await env.DB.prepare("SELECT task_id FROM task_leases WHERE expires_at <= unixepoch()").all();
    for (const row of expired.results) {
      await env.DB.batch([
        env.DB.prepare("DELETE FROM task_leases WHERE task_id=?").bind(row.task_id),
        env.DB.prepare("UPDATE tasks SET state='retrying', updated_at=unixepoch() WHERE id=? AND state IN ('dispatching','running')").bind(row.task_id),
      ]);
      await env.DISPATCH_QUEUE.send({ type: "dispatch", taskId: row.task_id });
    }
  },
};
