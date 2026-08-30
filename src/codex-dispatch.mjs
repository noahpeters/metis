const ALLOWED_BILLING_MODES = new Set(["included_subscription"]);

export function validateCapabilities(value) {
  if (!value || value.provider !== "codex" || value.execution !== "cloud") {
    throw new Error("Dispatcher is not a Codex cloud execution provider");
  }
  if (!ALLOWED_BILLING_MODES.has(value.billing_mode)) {
    throw new Error(`Dispatcher billing mode is not allowed: ${value.billing_mode || "unknown"}`);
  }
  if (value.accepting_tasks !== true) throw new Error("Codex dispatcher is not accepting tasks");
  return value;
}

async function dispatcherRequest(env, path, init = {}) {
  if (!env.CODEX_DISPATCH_URL) throw new Error("CODEX_DISPATCH_URL is not configured");
  const response = await fetch(`${env.CODEX_DISPATCH_URL.replace(/\/$/, "")}${path}`, {
    ...init,
    headers: {
      accept: "application/json",
      authorization: `Bearer ${env.CODEX_DISPATCH_TOKEN}`,
      ...init.headers,
    },
  });
  if (!response.ok) throw new Error(`Codex dispatcher ${path} failed (${response.status})`);
  return response.json();
}

export async function getCodexCapabilities(env) {
  return validateCapabilities(await dispatcherRequest(env, "/v1/capabilities"));
}

export function buildCodexTask(task, leaseId, callbackUrl) {
  if (!task?.id || !task.repository || !Number.isInteger(task.issue_number)) throw new Error("Invalid Codex task identity");
  if (!leaseId || !callbackUrl) throw new Error("Codex task requires a lease and callback URL");
  return {
    version: 1,
    task_id: task.id,
    lease_id: leaseId,
    repository: task.repository,
    issue_number: task.issue_number,
    summary: task.summary,
    execution_envelope: {
      max_cost_units: task.max_cost_units,
      merge: "forbidden",
      deployment: "forbidden",
      production_mutation: "forbidden",
      blocked_state: "required_for_missing_decisions",
    },
    instructions: "Inspect the repository deeply, implement, debug, verify, and substantively review. Open a PR but never merge or deploy. Return BLOCKED when a decision or missing information prevents safe progress.",
    callback_url: callbackUrl,
  };
}

export async function dispatchCodexTask(env, task, leaseId) {
  await getCodexCapabilities(env);
  const result = await dispatcherRequest(env, "/v1/tasks", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": leaseId },
    body: JSON.stringify(buildCodexTask(task, leaseId, `${env.PUBLIC_BASE_URL}/callbacks/codex`)),
  });
  if (!result?.id || !["queued", "running"].includes(result.status)) throw new Error("Codex dispatcher returned an invalid task receipt");
  return result;
}
