import { githubPaginatedRequest, repositoryAllowed } from "./github.mjs";

export class DependencyReconciliationError extends Error {
  constructor(message, cause) {
    super(message, { cause });
    this.name = "DependencyReconciliationError";
  }
}

function issueKey(issue) {
  const match = new URL(issue.repository_url).pathname.match(/^\/repos\/([^/]+\/[^/]+)$/);
  if (!match) throw new DependencyReconciliationError("GitHub returned an invalid dependency repository identity");
  return `${match[1]}#${issue.number}`;
}

export async function fetchBlockedBy(env, task, fetchAll = githubPaginatedRequest) {
  let issues;
  try {
    issues = await fetchAll(env, `/repos/${task.repository}/issues/${task.issue_number}/dependencies/blocked_by`);
  } catch (error) {
    throw new DependencyReconciliationError(`Could not reconcile dependencies for ${task.id}`, error);
  }
  const observedAt = Math.floor(Date.now() / 1000);
  const unique = new Map();
  for (const issue of issues) {
    if (!issue?.node_id || !issue?.repository_url || !Number.isInteger(issue.number)) {
      throw new DependencyReconciliationError(`GitHub returned an ambiguous dependency for ${task.id}`);
    }
    const key = issueKey(issue);
    const repository = key.slice(0, key.lastIndexOf("#"));
    if (!repositoryAllowed(env, repository)) throw new DependencyReconciliationError(`Dependency ${key} is outside the repository allowlist`);
    unique.set(issue.node_id, {
      dependentKey: task.id,
      dependentNodeId: task.issue_node_id,
      prerequisiteKey: key,
      prerequisiteNodeId: issue.node_id,
      state: issue.state,
      stateReason: issue.state_reason || null,
      completed: issue.state === "closed" && issue.state_reason === "completed",
      observedAt,
    });
  }
  return [...unique.values()];
}

export function findDependencyCycle(graph) {
  const visiting = new Set();
  const visited = new Set();
  const path = [];
  function visit(node) {
    if (visiting.has(node)) return [...path.slice(path.indexOf(node)), node];
    if (visited.has(node)) return null;
    visiting.add(node); path.push(node);
    for (const next of graph.get(node) || []) {
      const cycle = visit(next);
      if (cycle) return cycle;
    }
    path.pop(); visiting.delete(node); visited.add(node);
    return null;
  }
  for (const node of graph.keys()) {
    const cycle = visit(node);
    if (cycle) return cycle;
  }
  return null;
}

export async function mirrorDependencies(env, task, dependencies) {
  const statements = [env.DB.prepare("DELETE FROM github_dependencies WHERE dependent_node_id=?").bind(task.issue_node_id)];
  for (const dependency of dependencies) {
    statements.push(env.DB.prepare("INSERT INTO github_dependencies(dependent_key,dependent_node_id,prerequisite_key,prerequisite_node_id,prerequisite_state,prerequisite_state_reason,relationship_identity,observed_at,reconciliation_status) VALUES(?,?,?,?,?,?,?,?, 'current')")
      .bind(dependency.dependentKey, dependency.dependentNodeId, dependency.prerequisiteKey, dependency.prerequisiteNodeId, dependency.state, dependency.stateReason, `${dependency.dependentNodeId}:${dependency.prerequisiteNodeId}`, dependency.observedAt));
  }
  await env.DB.batch(statements);
}

export async function dependencyDecision(env, task, fetchAll) {
  const dependencies = await fetchBlockedBy(env, task, fetchAll);
  await mirrorDependencies(env, task, dependencies);
  const incomplete = dependencies.filter((dependency) => !dependency.completed);
  return incomplete.length
    ? { executable: false, kind: "dependency", waitingOn: incomplete.map((dependency) => dependency.prerequisiteKey), observedAt: dependencies[0]?.observedAt }
    : { executable: true, observedAt: dependencies[0]?.observedAt || Math.floor(Date.now() / 1000) };
}

export async function recordDependencyEvent(env, taskId, kind, evidence, fingerprint) {
  await env.DB.prepare("INSERT INTO dependency_events(fingerprint,task_id,kind,evidence_json,created_at) VALUES(?,?,?,?,unixepoch()) ON CONFLICT(fingerprint) DO NOTHING")
    .bind(fingerprint, taskId, kind, JSON.stringify(evidence)).run();
}
