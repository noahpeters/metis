import { fetchBlockedBy, findDependencyCycle } from "./dependencies.mjs";
import { loadProjectPolicy, readProjectQueue } from "./project.mjs";

// Produce one immutable observation which can be aggregated for every UI view.
// Any missing Project or dependency evidence fails closed rather than becoming
// an apparent dependency-free issue.
export async function observeExecutableReady(env, options = {}) {
  const policy = loadProjectPolicy(env.METIS_PROJECT_POLICY_JSON);
  const queue = await readProjectQueue(env, options.graphql);
  const candidates = queue.filter((item) => item.eligible && item.issueState === "OPEN");
  const dependencies = new Map();

  for (const item of candidates) {
    const key = `${item.repository}#${item.issueNumber}`;
    const task = { id: key, repository: item.repository, issue_number: item.issueNumber, issue_node_id: item.issueNodeId };
    dependencies.set(key, await fetchBlockedBy(env, task, options.fetchDependencies));
  }

  return classifyExecutableReady(queue, dependencies, policy);
}

export function classifyExecutableReady(queue, dependencies, policy) {
  const byKey = new Map(queue.map((item) => [`${item.repository}#${item.issueNumber}`, item]));
  const candidates = queue.filter((item) => item.eligible && item.issueState === "OPEN");
  if (candidates.some((item) => !dependencies.has(`${item.repository}#${item.issueNumber}`))) throw new Error("Ready issue dependency observation is incomplete");
  const graph = new Map(candidates.map((item) => {
    const key = `${item.repository}#${item.issueNumber}`;
    return [key, [...new Set((dependencies.get(key) || []).map((value) => value.prerequisiteKey))]];
  }));
  const cycle = findDependencyCycle(graph);
  const cycleMembers = new Set(cycle || []);
  const issues = candidates.map((item) => {
    const key = `${item.repository}#${item.issueNumber}`;
    const blockers = graph.get(key) || [];
    const blockersDone = blockers.every((blocker) => byKey.get(blocker)?.statusOptionId === policy.statusOptions.Done);
    return { repository: item.repository, issue_number: item.issueNumber, key, executable: !cycleMembers.has(key) && blockersDone, blocker_count: blockers.length };
  });
  return { issues, raw_ready_count: issues.length, executable_ready_count: issues.filter((issue) => issue.executable).length };
}

export function aggregateExecutableReady(observation, repository) {
  const issues = observation.issues.filter((issue) => issue.repository === repository);
  return { executable: issues.filter((issue) => issue.executable).length, raw: issues.length, waiting: issues.filter((issue) => !issue.executable).length };
}
