import { githubRequest } from "./github.mjs";

export const DISCUSSION_LIMITS = Object.freeze({ pages: 10, comments: 500, characters: 24_000 });

function sourceOf(comment) {
  const login = comment.user?.login || "unknown";
  const connector = comment.performed_via_github_app?.slug === "chatgpt-codex-connector";
  const metis = comment.performed_via_github_app?.slug === "metis-control-plane"
    || /^metis(?:\[bot\])?$/i.test(login)
    || /^## Metis\b/.test(comment.body || "");
  if (connector) return "codex-connector";
  if (metis) return "metis-status";
  return comment.user?.type === "Bot" ? "other-bot" : "human";
}

export function selectDiscussion(issue, comments, limits = DISCUSSION_LIMITS) {
  const normalized = comments.slice(0, limits.comments).map((comment) => ({
    id: comment.id,
    created_at: comment.created_at,
    updated_at: comment.updated_at,
    author: comment.user?.login || "unknown",
    source: sourceOf(comment),
    body: String(comment.body || ""),
  }));
  const relevant = normalized.filter((comment) => comment.source === "human" || comment.source === "codex-connector");
  const selected = [];
  let remaining = limits.characters;
  // Prefer the newest decisions under pressure, then restore authoritative chronology.
  for (const comment of [...relevant].reverse()) {
    if (!remaining) break;
    const body = comment.body.slice(0, remaining);
    if (!body) continue;
    selected.push({ ...comment, body });
    remaining -= body.length;
  }
  selected.reverse();
  return {
    issue: { id: issue.id, number: issue.number, title: issue.title || "", body: issue.body || "", updated_at: issue.updated_at },
    comments: selected,
    metis_status_count: normalized.filter((comment) => comment.source === "metis-status").length,
    omitted_relevant_count: relevant.length - selected.length,
    fetched_comment_count: normalized.length,
  };
}

export async function fetchIssueDiscussion(env, repository, issueNumber, limits = DISCUSSION_LIMITS) {
  const issue = await githubRequest(env, `/repos/${repository}/issues/${issueNumber}`);
  const comments = [];
  let pagesFetched = 0;
  for (let page = 1; page <= limits.pages && comments.length < limits.comments; page += 1) {
    const batch = await githubRequest(env, `/repos/${repository}/issues/${issueNumber}/comments?per_page=100&page=${page}&sort=created&direction=asc`);
    if (!Array.isArray(batch)) throw new Error("GitHub issue comments response was not a list");
    pagesFetched += 1;
    comments.push(...batch);
    if (batch.length < 100) break;
  }
  const result = selectDiscussion(issue, comments, limits);
  return { ...result, pages_fetched: pagesFetched, truncated: comments.length >= limits.comments };
}

export function discussionMetadata(discussion) {
  return {
    issue_id: discussion.issue.id,
    issue_updated_at: discussion.issue.updated_at,
    comment_ids: discussion.comments.map((comment) => comment.id),
    comment_updated_at: discussion.comments.map((comment) => comment.updated_at),
    fetched_comment_count: discussion.fetched_comment_count,
    metis_status_count: discussion.metis_status_count,
    omitted_relevant_count: discussion.omitted_relevant_count,
    pages_fetched: discussion.pages_fetched,
    truncated: discussion.truncated,
  };
}

export function buildIntakeInvestigation(task, discussion, rawProjectPolicy) {
  let configuredProjectId = null;
  let projectPolicyStatus = "unavailable";
  try {
    const policy = JSON.parse(rawProjectPolicy || "null");
    configuredProjectId = typeof policy?.projectId === "string" ? policy.projectId : null;
    projectPolicyStatus = configuredProjectId ? "configured" : "unavailable";
  } catch { projectPolicyStatus = "invalid"; }
  const mentionedProjectIds = [...new Set(discussion.comments
    .filter((comment) => comment.source === "human")
    .flatMap((comment) => comment.body.match(/PVT_[A-Za-z0-9_-]+/g) || []))];
  const conflictingProjectIds = [...new Set([configuredProjectId, ...mentionedProjectIds].filter(Boolean))];
  return {
    bounds: { sources: ["issue-discussion", "project-policy", "control-plane-task"], external_requests: 0 },
    project: {
      policy_status: projectPolicyStatus,
      configured_id: configuredProjectId,
      human_mentioned_ids: mentionedProjectIds,
      evidence: conflictingProjectIds.length > 1 ? "conflicting" : conflictingProjectIds.length === 1 ? "consistent" : "not_found",
    },
    control_plane_task: { id: task.id, issue_node_id: task.issue_node_id, size_class: task.size_class, max_workload_units: task.max_workload_units },
  };
}
