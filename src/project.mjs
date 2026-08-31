import { githubRequest, repositoryAllowed } from "./github.mjs";

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
  if (!status || status.name !== "Status" || !status.options?.some((option) => option.id === policy.readyStatusOptionId && option.name === "Ready")) {
    throw new ProjectAdmissionError("Project Ready status schema does not match configured IDs");
  }
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
  const active = await env.DB.prepare("SELECT COUNT(*) AS count FROM task_leases WHERE expires_at > unixepoch()").first();
  const max = Number(options.maxConcurrentTasks ?? JSON.parse(env.METIS_POLICY_JSON || "{}").global?.maxConcurrentTasks ?? 2);
  let available = Math.max(0, max - (active?.count || 0));
  let admitted = 0;
  for (const item of queue) {
    if (!item.eligible || available === 0) continue;
    const id = `${item.repository}#${item.issueNumber}`;
    if (await env.DB.prepare("SELECT id FROM tasks WHERE id=?").bind(id).first()) continue;
    const issue = await githubRequest(env, `/repos/${item.repository}/issues/${item.issueNumber}`);
    if (issue.node_id !== item.issueNodeId || issue.pull_request || issue.state !== "open") throw new ProjectAdmissionError(`Authoritative issue ${id} is inaccessible or no longer eligible`);
    const labels = labelsOf(issue);
    const size = labels.find((label) => /^metis:size-(small|medium|large|unknown)$/.test(label));
    const cost = labels.find((label) => /^metis:max-cost-\d+$/.test(label));
    await env.DB.prepare("INSERT INTO tasks (id,repository,issue_number,issue_node_id,title,body,state,actor,size_class,max_cost_units,budget_approved,created_at,updated_at) VALUES (?,?,?,?,?,?,'intake','metis-project',?,?,?,unixepoch(),unixepoch()) ON CONFLICT(id) DO NOTHING")
      .bind(id, item.repository, item.issueNumber, issue.node_id, issue.title || "", issue.body || "", size?.slice(11) || null, cost ? Number(cost.slice(15)) : null, labels.includes("metis:budget-approved") ? 1 : 0).run();
    await env.DISPATCH_QUEUE.send({ type: "intake", taskId: id });
    admitted += 1;
    available -= 1;
  }
  return { observed: queue.length, admitted };
}
