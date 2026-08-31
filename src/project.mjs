import { githubRequest, repositoryAllowed } from "./github.mjs";
import { fetchBlockedBy, findDependencyCycle, mirrorDependencies, recordDependencyEvent } from "./dependencies.mjs";

const ITEMS_QUERY = `query MetisProjectItems($project: ID!, $cursor: String) {
  node(id: $project) {
    ... on ProjectV2 {
      id
      fields(first: 100) { nodes { ... on ProjectV2SingleSelectField { id name options { id name } } } }
      items(first: 100, after: $cursor, orderBy: {field: POSITION, direction: ASC}) {
        nodes {
          id isArchived
          content { __typename ... on Issue { id number title body repository { nameWithOwner } } }
          fieldValues(first: 100) { nodes { ... on ProjectV2ItemFieldSingleSelectValue { optionId field { ... on ProjectV2SingleSelectField { id } } } } }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`;

const UPDATE_STATUS_MUTATION = `mutation MetisMirrorProjectStatus($project: ID!, $item: ID!, $field: ID!, $option: String!) {
  updateProjectV2ItemFieldValue(input: {projectId: $project, itemId: $item, fieldId: $field, value: {singleSelectOptionId: $option}}) { projectV2Item { id } }
}`;

export const PROJECT_STATUS_NAMES = ["Backlog", "Ready", "In progress", "Awaiting human", "Blocked", "Deploying", "Done"];

export function projectStatusForState(state) {
  if (["intake"].includes(state)) return "Backlog";
  if (["ready", "retrying"].includes(state)) return "Ready";
  if (["dispatching", "running", "revising"].includes(state)) return "In progress";
  if (["awaiting_pr_creation", "awaiting_revision_pr", "pr_ready", "reviewing", "merge_ready"].includes(state)) return "Awaiting human";
  if (["blocked", "budget_blocked", "failed", "recovery_blocked"].includes(state)) return "Blocked";
  if (["deploying", "recovery"].includes(state)) return "Deploying";
  if (state === "complete") return "Done";
  return null;
}

export class ProjectAdmissionError extends Error {
  constructor(message) {
    super(message);
    this.name = "ProjectAdmissionError";
  }
}

export function loadProjectPolicy(raw) {
  if (!raw) throw new ProjectAdmissionError("METIS_PROJECT_POLICY_JSON is not configured");
  let value;
  try { value = typeof raw === "string" ? JSON.parse(raw) : raw; } catch { throw new ProjectAdmissionError("METIS_PROJECT_POLICY_JSON is invalid JSON"); }
  for (const key of ["projectId", "executionOwnerFieldId", "metisOwnerOptionId", "statusFieldId", "readyStatusOptionId"]) {
    if (typeof value[key] !== "string" || !value[key]) throw new ProjectAdmissionError(`Project policy is missing ${key}`);
  }
  if (!value.statusOptions || typeof value.statusOptions !== "object") throw new ProjectAdmissionError("Project policy is missing statusOptions");
  for (const name of PROJECT_STATUS_NAMES) {
    if (typeof value.statusOptions[name] !== "string" || !value.statusOptions[name]) throw new ProjectAdmissionError(`Project policy is missing Status option ID for ${name}`);
  }
  if (value.statusOptions.Ready !== value.readyStatusOptionId) throw new ProjectAdmissionError("Project Ready option IDs are inconsistent");
  return value;
}

async function projectGraphql(env, query, variables) {
  if (!env.METIS_PROJECT_USER_TOKEN) throw new ProjectAdmissionError("METIS_PROJECT_USER_TOKEN is not configured");
  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${env.METIS_PROJECT_USER_TOKEN}`, "Content-Type": "application/json", "User-Agent": "metis-control-plane" },
    body: JSON.stringify({ query, variables }),
  });
  if (!response.ok) throw new ProjectAdmissionError(`Project GraphQL request failed (${response.status})`);
  const result = await response.json();
  if (result.errors?.length) throw new ProjectAdmissionError(`Project GraphQL rejected the request: ${result.errors[0].message}`);
  return result.data;
}

function validateSchema(project, policy) {
  const fields = (project.fields?.nodes || []).filter(Boolean);
  const owner = fields.find((field) => field.id === policy.executionOwnerFieldId);
  const status = fields.find((field) => field.id === policy.statusFieldId);
  if (!owner || owner.name !== "Execution owner" || !owner.options?.some((option) => option.id === policy.metisOwnerOptionId && option.name === "Metis")) {
    throw new ProjectAdmissionError("Project Execution owner schema does not match configured IDs");
  }
  if (!status || status.name !== "Status") throw new ProjectAdmissionError("Project Status field is missing or is not a single-select field");
  const names = new Set();
  for (const option of status.options || []) {
    if (names.has(option.name)) throw new ProjectAdmissionError(`Project Status contains duplicate option name ${option.name}`);
    names.add(option.name);
  }
  for (const name of PROJECT_STATUS_NAMES) {
    if (!status.options?.some((option) => option.id === policy.statusOptions[name] && option.name === name)) {
      throw new ProjectAdmissionError(`Project Status option ${name} does not match its configured ID`);
    }
  }
}

export function planProjectStatusSchema(project, policy, { dryRun = true } = {}) {
  const status = (project.fields?.nodes || []).find((field) => field?.id === policy.statusFieldId);
  if (!status || status.name !== "Status" || !Array.isArray(status.options)) throw new ProjectAdmissionError("Project Status field is missing or is not a single-select field");
  const duplicate = status.options.find((option, index) => status.options.findIndex((other) => other.name === option.name) !== index);
  if (duplicate) throw new ProjectAdmissionError(`Project Status contains duplicate option name ${duplicate.name}`);
  const missing = PROJECT_STATUS_NAMES.filter((name) => !status.options.some((option) => option.name === name));
  const incompatible = PROJECT_STATUS_NAMES.filter((name) => status.options.some((option) => option.name === name && option.id !== policy.statusOptions[name]));
  if (incompatible.length) throw new ProjectAdmissionError(`Project Status has incompatible configured IDs: ${incompatible.join(", ")}`);
  if (!dryRun && missing.length) throw new ProjectAdmissionError("Refusing to replace Status options automatically because existing option IDs must be preserved");
  return { dryRun, changes: missing.map((name) => `add Status option: ${name}`), unchanged: PROJECT_STATUS_NAMES.filter((name) => !missing.includes(name)) };
}

async function recordStatusSyncFailure(env, taskId, statusName, error) {
  await env.DB.prepare("INSERT INTO project_status_sync(task_id,status_name,last_error,attempt_count,updated_at) VALUES(?,?,?,1,unixepoch()) ON CONFLICT(task_id) DO UPDATE SET status_name=excluded.status_name,last_error=excluded.last_error,attempt_count=project_status_sync.attempt_count+1,updated_at=unixepoch()")
    .bind(taskId, statusName, String(error?.message || error)).run();
}

export async function reconcileProjectStatuses(env, queue, options = {}) {
  const policy = loadProjectPolicy(env.METIS_PROJECT_POLICY_JSON);
  const graphql = options.graphql || projectGraphql;
  let repaired = 0;
  for (const item of queue) {
    const taskId = `${item.repository}#${item.issueNumber}`;
    const task = await env.DB.prepare("SELECT state FROM tasks WHERE id=?").bind(taskId).first();
    const statusName = projectStatusForState(task?.state);
    if (!statusName) continue;
    const optionId = policy.statusOptions[statusName];
    if (item.statusOptionId === optionId) {
      await env.DB.prepare("DELETE FROM project_status_sync WHERE task_id=?").bind(taskId).run();
      continue;
    }
    try {
      await graphql(env, UPDATE_STATUS_MUTATION, { project: policy.projectId, item: item.projectItemId, field: policy.statusFieldId, option: optionId });
      await env.DB.prepare("DELETE FROM project_status_sync WHERE task_id=?").bind(taskId).run();
      repaired += 1;
    } catch (error) {
      await recordStatusSyncFailure(env, taskId, statusName, error);
    }
  }
  return { repaired };
}

export async function readProjectQueue(env, graphql = projectGraphql) {
  const policy = loadProjectPolicy(env.METIS_PROJECT_POLICY_JSON);
  const ordered = [];
  let cursor = null;
  do {
    const data = await graphql(env, ITEMS_QUERY, { project: policy.projectId, cursor });
    const project = data?.node;
    if (!project || project.id !== policy.projectId) throw new ProjectAdmissionError("Configured ProjectV2 is inaccessible or deleted");
    validateSchema(project, policy);
    const connection = project.items;
    if (!connection?.nodes || !connection.pageInfo) throw new ProjectAdmissionError("Project item pagination response is incomplete");
    ordered.push(...connection.nodes);
    if (connection.pageInfo.hasNextPage && !connection.pageInfo.endCursor) throw new ProjectAdmissionError("Project pagination did not return an end cursor");
    cursor = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null;
  } while (cursor);

  const seenItems = new Set();
  const seenIssues = new Set();
  return ordered.map((item, orderIndex) => {
    if (!item?.id || seenItems.has(item.id)) throw new ProjectAdmissionError("Project contains a duplicate item");
    seenItems.add(item.id);
    if (item.isArchived) return null;
    if (item.content?.__typename !== "Issue") throw new ProjectAdmissionError(`Project item ${item.id} is not an accessible issue`);
    const repository = item.content.repository?.nameWithOwner;
    if (!repositoryAllowed(env, repository)) throw new ProjectAdmissionError(`Project item ${item.id} belongs to a disallowed repository`);
    const issueKey = `${repository}#${item.content.number}`;
    if (seenIssues.has(issueKey)) throw new ProjectAdmissionError(`Project contains duplicate issue ${issueKey}`);
    seenIssues.add(issueKey);
    const values = new Map((item.fieldValues?.nodes || []).filter((value) => value?.field?.id).map((value) => [value.field.id, value.optionId]));
    return { projectItemId: item.id, orderIndex, repository, issueNumber: item.content.number, issueNodeId: item.content.id, ownerOptionId: values.get(policy.executionOwnerFieldId), statusOptionId: values.get(policy.statusFieldId), eligible: values.get(policy.executionOwnerFieldId) === policy.metisOwnerOptionId && values.get(policy.statusFieldId) === policy.readyStatusOptionId };
  }).filter(Boolean);
}

function labelsOf(issue) { return (issue.labels || []).map((label) => typeof label === "string" ? label : label.name); }

export async function reconcileProject(env, options = {}) {
  const queue = await readProjectQueue(env, options.graphql);
  const status = await reconcileProjectStatuses(env, queue, options);
  const active = await env.DB.prepare("SELECT COUNT(*) AS count FROM task_leases WHERE expires_at > unixepoch()").first();
  const max = Number(options.maxConcurrentTasks ?? JSON.parse(env.METIS_POLICY_JSON || "{}").global?.maxConcurrentTasks ?? 2);
  let available = Math.max(0, max - (active?.count || 0));
  let admitted = 0;
  const ready = [];
  const dependencyGraph = new Map();
  for (const item of queue) {
    if (!item.eligible) continue;
    const id = `${item.repository}#${item.issueNumber}`;
    const existing = await env.DB.prepare("SELECT * FROM tasks WHERE id=?").bind(id).first();
    if (existing?.state !== "ready") continue;
    let dependencies;
    try {
      dependencies = await fetchBlockedBy(env, existing, options.fetchDependencies);
      await mirrorDependencies(env, existing, dependencies);
    } catch (error) {
      await recordDependencyEvent(env, id, "reconciliation-error", { message: error.message }, `reconciliation-error:${id}:${Math.floor(Date.now() / 3600000)}`);
      throw new ProjectAdmissionError(error.message);
    }
    dependencyGraph.set(id, dependencies.map((dependency) => dependency.prerequisiteKey));
    ready.push({ item, task: existing, dependencies });
  }
  const cycle = findDependencyCycle(dependencyGraph);
  const cycleMembers = new Set(cycle || []);
  if (cycle) await recordDependencyEvent(env, cycle[0], "cycle", { chain: cycle }, `cycle:${cycle.join("->")}`);
  for (const item of queue) {
    if (!item.eligible || available === 0) continue;
    const id = `${item.repository}#${item.issueNumber}`;
    const existing = await env.DB.prepare("SELECT id,state FROM tasks WHERE id=?").bind(id).first();
    if (existing) {
      if (existing.state === "ready") {
        const observation = ready.find((candidate) => candidate.task.id === id);
        if (!observation || cycleMembers.has(id)) continue;
        const waitingOn = observation.dependencies.filter((dependency) => !dependency.completed).map((dependency) => dependency.prerequisiteKey);
        if (waitingOn.length) {
          await recordDependencyEvent(env, id, "deferred", { waiting_on: waitingOn, observed_at: observation.dependencies[0]?.observedAt }, `deferred:${id}:${waitingOn.sort().join(",")}`);
          continue;
        }
        await recordDependencyEvent(env, id, "satisfied", { observed_at: observation.dependencies[0]?.observedAt }, `satisfied:${id}:${observation.dependencies[0]?.observedAt || "none"}`);
        await env.DISPATCH_QUEUE.send({ type: "dispatch", taskId: id });
        admitted += 1;
        available -= 1;
      }
      continue;
    }
    const issue = await githubRequest(env, `/repos/${item.repository}/issues/${item.issueNumber}`);
    if (issue.node_id !== item.issueNodeId || issue.pull_request || issue.state !== "open") throw new ProjectAdmissionError(`Authoritative issue ${id} is inaccessible or no longer eligible`);
    const labels = labelsOf(issue);
    const size = labels.find((label) => /^metis:size-(small|medium|large|unknown)$/.test(label));
    const cost = labels.find((label) => /^metis:max-cost-\d+$/.test(label));
    await env.DB.prepare("INSERT INTO tasks (id,repository,issue_number,issue_node_id,title,body,state,actor,size_class,max_workload_units,budget_approved,created_at,updated_at) VALUES (?,?,?,?,?,?,'intake','metis-project',?,?,?,unixepoch(),unixepoch()) ON CONFLICT(id) DO NOTHING")
      .bind(id, item.repository, item.issueNumber, issue.node_id, issue.title || "", issue.body || "", size?.slice(11) || null, cost ? Number(cost.slice(15)) : null, labels.includes("metis:budget-approved") ? 1 : 0).run();
    await env.DISPATCH_QUEUE.send({ type: "intake", taskId: id });
    admitted += 1;
    available -= 1;
  }
  return { observed: queue.length, admitted, statusRepaired: status.repaired };
}
