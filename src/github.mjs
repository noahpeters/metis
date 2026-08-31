const STATE_LABELS = ["metis:ready", "metis:planning", "metis:implementing", "metis:revising", "metis:reviewing", "metis:awaiting-pr", "metis:blocked", "metis:budget-blocked", "metis:pr-ready", "metis:merge-ready", "metis:merging", "metis:deploying", "metis:complete", "metis:recovery", "metis:recovery-blocked", "metis:failed"];

let installationTokenCache;

function base64Url(value) {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function pemBytes(pem) {
  const encoded = pem.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, "");
  const binary = atob(encoded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export async function createGithubAppJwt(appId, privateKey, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (!appId || !privateKey) throw new Error("GitHub App credentials are incomplete");
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64Url(JSON.stringify({ iat: nowSeconds - 60, exp: nowSeconds + 540, iss: String(appId) }));
  const unsigned = `${header}.${payload}`;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemBytes(privateKey),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
  return `${unsigned}.${base64Url(signature)}`;
}

async function githubToken(env) {
  if (env.GITHUB_TOKEN) return env.GITHUB_TOKEN;
  if (!env.GITHUB_APP_ID || !env.GITHUB_APP_INSTALLATION_ID || !env.GITHUB_APP_PRIVATE_KEY) {
    throw new Error("GitHub authentication is not configured");
  }
  const now = Date.now();
  if (installationTokenCache?.expiresAt > now + 60_000) return installationTokenCache.token;
  const jwt = await createGithubAppJwt(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY);
  const response = await fetch(`https://api.github.com/app/installations/${env.GITHUB_APP_INSTALLATION_ID}/access_tokens`, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${jwt}`,
      "User-Agent": "metis-control-plane",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!response.ok) throw new Error(`GitHub installation token request failed (${response.status})`);
  const result = await response.json();
  installationTokenCache = { token: result.token, expiresAt: Date.parse(result.expires_at) };
  return result.token;
}

export async function githubRequest(env, path, init = {}) {
  const token = await githubToken(env);
  return authenticatedGithubRequest(token, path, init);
}

export async function githubPaginatedRequest(env, path, { perPage = 100 } = {}) {
  const separator = path.includes("?") ? "&" : "?";
  const results = [];
  for (let page = 1; ; page += 1) {
    const batch = await githubRequest(env, `${path}${separator}per_page=${perPage}&page=${page}`);
    if (!Array.isArray(batch)) throw new Error(`GitHub pagination response for ${path} is not an array`);
    results.push(...batch);
    if (batch.length < perPage) return results;
  }
}

export async function githubGraphql(env, query, variables) {
  const token = await githubToken(env);
  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "metis-control-plane",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!response.ok) throw new Error(`GitHub GraphQL failed (${response.status})`);
  const result = await response.json();
  if (result.errors?.length) throw new Error(`GitHub GraphQL rejected the operation: ${result.errors[0].message}`);
  return result.data;
}

export async function unresolvedReviewThreadCount(env, repository, pullRequestNumber) {
  const [owner, name] = repository.split("/");
  const data = await githubGraphql(env, `
    query MetisReviewThreads($owner: String!, $name: String!, $number: Int!) {
      repository(owner: $owner, name: $name) {
        pullRequest(number: $number) { reviewThreads(first: 100) { nodes { isResolved } } }
      }
    }
  `, { owner, name, number: pullRequestNumber });
  return (data.repository?.pullRequest?.reviewThreads?.nodes || []).filter((thread) => !thread.isResolved).length;
}

async function authenticatedGithubRequest(token, path, init = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "metis-control-plane",
      "X-GitHub-Api-Version": "2022-11-28",
      ...init.headers,
    },
  });
  if (!response.ok) {
    const error = new Error(`GitHub ${init.method || "GET"} ${path} failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return response.status === 204 ? null : response.json();
}

export async function githubUserRequest(env, path, init = {}) {
  if (!env.GITHUB_DISPATCH_USER_TOKEN) {
    throw new Error("GitHub Codex user dispatch credential is not configured");
  }
  return authenticatedGithubRequest(env.GITHUB_DISPATCH_USER_TOKEN, path, init);
}

export function repositoryAllowed(env, repository) {
  return (env.ALLOWED_REPOSITORIES || "").split(",").map((item) => item.trim()).includes(repository);
}

export async function setState(env, repository, issueNumber, nextState) {
  const issue = await githubRequest(env, `/repos/${repository}/issues/${issueNumber}`);
  const labels = issue.labels.map((label) => typeof label === "string" ? label : label.name);
  if (!labels.includes(nextState)) {
    try {
      await githubRequest(env, `/repos/${repository}/labels/${encodeURIComponent(nextState)}`);
    } catch (error) {
      if (error.status !== 404) throw error;
      await githubRequest(env, `/repos/${repository}/labels`, {
        method: "POST",
        body: JSON.stringify({ name: nextState, color: nextState.includes("blocked") || nextState === "metis:recovery" ? "b60205" : nextState === "metis:complete" ? "0e8a16" : "1d76db", description: "Metis lifecycle state" }),
      });
    }
  }
  const nextLabels = [...labels.filter((label) => !STATE_LABELS.includes(label)), nextState];
  await githubRequest(env, `/repos/${repository}/issues/${issueNumber}`, {
    method: "PATCH",
    body: JSON.stringify({ labels: nextLabels }),
  });
}

export async function comment(env, repository, issueNumber, body) {
  return githubRequest(env, `/repos/${repository}/issues/${issueNumber}/comments`, {
    method: "POST",
    body: JSON.stringify({ body }),
  });
}

export async function blockTask(env, task, reason, question, budget = false) {
  const state = budget ? "metis:budget-blocked" : "metis:blocked";
  await setState(env, task.repository, task.issue_number, state);
  await comment(env, task.repository, task.issue_number, [
    `## Metis is ${budget ? "blocked on task approval" : "blocked"}`,
    "",
    reason,
    "",
    `**Decision or information needed:** ${question}`,
    "",
    budget
      ? "Metis stopped before starting or retrying coding work. Approve or reduce the task-specific execution envelope, then reapply `metis:ready`."
      : "Reply with the missing information, then reapply `metis:ready` when the task should continue.",
  ].join("\n"));
}
