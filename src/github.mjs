const STATE_LABELS = ["metis:ready", "metis:planning", "metis:implementing", "metis:reviewing", "metis:blocked", "metis:budget-blocked", "metis:pr-ready", "metis:failed"];

async function request(env, path, init = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      "User-Agent": "metis-control-plane",
      "X-GitHub-Api-Version": "2022-11-28",
      ...init.headers,
    },
  });
  if (!response.ok) throw new Error(`GitHub ${init.method || "GET"} ${path} failed (${response.status})`);
  return response.status === 204 ? null : response.json();
}

export function repositoryAllowed(env, repository) {
  return (env.ALLOWED_REPOSITORIES || "").split(",").map((item) => item.trim()).includes(repository);
}

export async function setState(env, repository, issueNumber, nextState) {
  const issue = await request(env, `/repos/${repository}/issues/${issueNumber}`);
  const labels = issue.labels.map((label) => typeof label === "string" ? label : label.name);
  const nextLabels = [...labels.filter((label) => !STATE_LABELS.includes(label)), nextState];
  await request(env, `/repos/${repository}/issues/${issueNumber}`, {
    method: "PATCH",
    body: JSON.stringify({ labels: nextLabels }),
  });
}

export async function comment(env, repository, issueNumber, body) {
  await request(env, `/repos/${repository}/issues/${issueNumber}/comments`, {
    method: "POST",
    body: JSON.stringify({ body }),
  });
}

export async function blockTask(env, task, reason, question, budget = false) {
  const state = budget ? "metis:budget-blocked" : "metis:blocked";
  await setState(env, task.repository, task.issue_number, state);
  await comment(env, task.repository, task.issue_number, [
    `## Metis is ${budget ? "blocked on budget or capacity" : "blocked"}`,
    "",
    reason,
    "",
    `**Decision or information needed:** ${question}`,
    "",
    budget
      ? "Metis stopped before starting or retrying coding work. Increase capacity, change the task budget, or reapply `metis:ready` after capacity resets."
      : "Reply with the missing information, then reapply `metis:ready` when the task should continue.",
  ].join("\n"));
}
