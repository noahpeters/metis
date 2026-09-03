import { githubRequest } from "./github.mjs";
import { lifecyclePolicy } from "./lifecycle.mjs";
import { readProjectStatusCounts } from "./project.mjs";

const SUCCESS = new Set(["success", "neutral", "skipped"]);
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const authorized = (email) => typeof email === "string" && /^[^@]+@from-trees\.com$/i.test(email);

export function recoveryEvidencePolicy(env, repository) {
  const policy = lifecyclePolicy(env, repository).recoveryEvidence || "exact_sha";
  return ["exact_sha", "latest_main_success"].includes(policy) ? policy : "exact_sha";
}

export function selectRecoveryEvidence(runs, workflowNames, blockingSha, policy) {
  const groups = new Map();
  for (const run of runs) {
    if (run.event !== "push" || run.head_branch !== "main" || !workflowNames.includes(run.name)) continue;
    const prior = groups.get(run.head_sha) || new Map();
    const old = prior.get(run.name);
    if (!old || (run.run_attempt || 1) > (old.run_attempt || 1) || run.id > old.id) prior.set(run.name, run);
    groups.set(run.head_sha, prior);
  }
  const candidates = [...groups].map(([sha, byName]) => ({ sha, byName, timestamp: Math.max(...[...byName.values()].map((run) => Date.parse(run.updated_at || run.created_at || 0))) }))
    .filter(({ byName }) => workflowNames.every((name) => SUCCESS.has(byName.get(name)?.conclusion)))
    .sort((a, b) => b.timestamp - a.timestamp);
  const selected = policy === "exact_sha" ? candidates.find((item) => item.sha === blockingSha) : candidates[0];
  if (!selected) return null;
  return { head_sha: selected.sha, exact_sha: selected.sha === blockingSha, runs: workflowNames.map((name) => ({ id: selected.byName.get(name).id, name, url: selected.byName.get(name).html_url, conclusion: selected.byName.get(name).conclusion })) };
}

async function configuredRepositories(env) {
  return (env.ALLOWED_REPOSITORIES || "").split(",").map((value) => value.trim()).filter(Boolean);
}

export async function repositoryOverviewForIdentity(email, env, observeProject = readProjectStatusCounts) {
  if (!authorized(email)) return json({ error: { code: "unauthorized", message: "Administrator identity required" } }, 401);
  const repositories = await configuredRepositories(env);
  let projectCounts = null;
  try { projectCounts = await observeProject(env); } catch { /* An unavailable observation must not be represented as zero. */ }
  const cards = [];
  for (const repository of repositories) {
    const [health, ready, recoveryTask, recent] = await Promise.all([
      env.DB.prepare("SELECT * FROM repository_health WHERE repository=?").bind(repository).first(),
      env.DB.prepare("SELECT COUNT(*) count FROM tasks WHERE repository=? AND state='ready'").bind(repository).first(),
      env.DB.prepare("SELECT id,issue_number,state,pull_request_number,pull_request_url,blocker_reason,updated_at FROM tasks WHERE repository=? AND is_recovery=1 ORDER BY updated_at DESC LIMIT 1").bind(repository).first(),
      env.DB.prepare("SELECT head_sha,workflow_name,conclusion,workflow_url,updated_at FROM deployment_runs WHERE repository=? ORDER BY updated_at DESC LIMIT 12").bind(repository).all(),
    ]);
    let recoveryPr = null;
    if (recoveryTask?.pull_request_number) {
      try {
        const pr = await githubRequest(env, `/repos/${repository}/pulls/${recoveryTask.pull_request_number}`);
        recoveryPr = { number: pr.number, url: pr.html_url, state: pr.merged ? "merged" : pr.state === "closed" ? "closed_unmerged" : pr.state };
      } catch { recoveryPr = { number: recoveryTask.pull_request_number, url: recoveryTask.pull_request_url, state: "inaccessible" }; }
    }
    const state = health?.state || "healthy";
    cards.push({ repository, state, dispatch_locked: state !== "healthy", blocking_sha: health?.blocking_sha || null, workflow_url: health?.workflow_url || null, root_task_id: health?.root_task_id || null, recovery_attempts: health?.recovery_attempts || 0, updated_at: health?.updated_at || null, ready_count: ready?.count || 0, project_counts: projectCounts?.[repository] || null, recovery_task: recoveryTask || null, recovery_pr: recoveryPr, deployment_evidence: recent.results || [], evidence_policy: recoveryEvidencePolicy(env, repository), waiting_reason: state === "healthy" ? null : `Normal dispatch is frozen while recovery for ${health?.blocking_sha || "main"} is unresolved.` });
  }
  return json({ repositories: cards, observed_at: new Date().toISOString() });
}

export async function revalidateRepositoryForIdentity(email, request, env, resumeBacklog) {
  if (!authorized(email)) return json({ error: { code: "unauthorized", message: "Administrator identity required" } }, 401);
  const idempotencyKey = request.headers.get("Idempotency-Key")?.trim();
  let body;
  try { body = await request.json(); } catch { return json({ error: { code: "invalid_json", message: "A JSON request is required" } }, 400); }
  if (!idempotencyKey || !body.request_id || typeof body.reason !== "string" || body.reason.trim().length < 8 || !Number.isInteger(body.expected_updated_at) || body.confirmation !== "REVALIDATE_RECOVERY") return json({ error: { code: "invalid_request", message: "Confirmation, reason, request ID, idempotency key, and observed version are required" } }, 400);
  if (!(await configuredRepositories(env)).includes(body.repository)) return json({ error: { code: "unknown_repository", message: "Repository is not managed" } }, 404);
  const duplicate = await env.DB.prepare("SELECT outcome_json FROM recovery_admin_audit WHERE idempotency_key=? OR request_id=?").bind(idempotencyKey, body.request_id).first();
  if (duplicate) return json({ ...JSON.parse(duplicate.outcome_json), duplicate: true });
  const health = await env.DB.prepare("SELECT * FROM repository_health WHERE repository=?").bind(body.repository).first();
  if (!health || health.state === "healthy" || health.updated_at !== body.expected_updated_at) return json({ error: { code: "stale_state", message: "Repository evidence changed; refresh before confirming" } }, 409);
  const policy = recoveryEvidencePolicy(env, body.repository);
  const workflowNames = lifecyclePolicy(env, body.repository).deploymentWorkflows;
  if (!workflowNames.length) return json({ error: { code: "ambiguous_evidence", message: "No deployment workflows are configured" } }, 409);
  let runs;
  try { runs = (await githubRequest(env, `/repos/${body.repository}/actions/runs?branch=main&event=push&per_page=100`)).workflow_runs; }
  catch { return json({ error: { code: "evidence_inaccessible", message: "GitHub deployment evidence could not be verified" } }, 503); }
  const evidence = selectRecoveryEvidence(runs || [], workflowNames, health.blocking_sha, policy);
  if (!evidence) return json({ retained: true, state: health.state, message: "No successful deployment satisfies the configured recovery policy." }, 409);
  const before = { ...health };
  const result = await env.DB.prepare("UPDATE repository_health SET state='healthy',blocking_sha=NULL,workflow_url=NULL,recovery_attempts=0,updated_at=MAX(unixepoch(),updated_at+1) WHERE repository=? AND state!='healthy' AND updated_at=?").bind(body.repository, body.expected_updated_at).run();
  if (result.meta?.changes !== 1) return json({ error: { code: "stale_state", message: "Repository evidence changed during confirmation" } }, 409);
  const outcome = { repaired: true, repository: body.repository, state: "healthy", selected_evidence: evidence, policy };
  await env.DB.prepare("INSERT INTO recovery_admin_audit(request_id,idempotency_key,repository,actor_email,reason,before_json,after_json,evidence_json,outcome_json,deployment_version,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,unixepoch())").bind(body.request_id, idempotencyKey, body.repository, email.toLowerCase(), body.reason.trim(), JSON.stringify(before), JSON.stringify({ state: "healthy" }), JSON.stringify(evidence), JSON.stringify(outcome), env.DEPLOYMENT_VERSION || null).run();
  await resumeBacklog();
  return json(outcome);
}
