import assert from "node:assert/strict";
import test from "node:test";
import { administerIssueForIdentity } from "../src/issue-admin.mjs";

function envFor(task) {
  const batches = [];
  return {
    GITHUB_TOKEN: "test-token",
    ALLOWED_REPOSITORIES: "owner/repo",
    DB: {
      prepare(sql) { return { sql, args: [], bind(...args) { this.args = args; return this; }, async first() {
        if (sql.startsWith("SELECT after_json")) return null;
        if (sql.startsWith("SELECT * FROM tasks")) return task;
        return null;
      } }; },
      async batch(statements) { batches.push(statements.map(({ sql, args }) => ({ sql, args }))); return statements.map(() => ({ meta: { changes: 1 } })); },
    },
    batches,
  };
}

async function withGithub(label, run) {
  const original = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url: String(url), method: init.method || "GET", body: init.body && JSON.parse(init.body) });
    if (!init.method) return new Response(JSON.stringify({ labels: [{ name: label }] }), { status: 200 });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  try { return await run(requests); } finally { globalThis.fetch = original; }
}

const task = { id: "owner/repo#4", repository: "owner/repo", issue_number: 4, state: "retrying", blocker_reason: null, attempt_count: 1, pull_request_url: null, merge_sha: null, updated_at: 100 };

test("reset to Ready supersedes active processing while retaining an audit record", async () => {
  const env = envFor(task); let resumed = 0;
  await withGithub("metis:ready", async () => {
    const response = await administerIssueForIdentity("admin@from-trees.com", new Request("https://ui/api/issues/reset-ready", { method: "POST", headers: { "content-type": "application/json", "Idempotency-Key": "key-1" }, body: JSON.stringify({ repository: "owner/repo", issue_number: 4, expected_updated_at: 100, confirmation: "RESET_TO_READY", reason: "Clear stale lease", request_id: "request-1" }) }), env, async () => { resumed += 1; }, "reset_ready");
    assert.equal(response.status, 200);
  });
  assert.equal(resumed, 1);
  const sql = env.batches[0].map(({ sql }) => sql).join("\n");
  assert.match(sql, /DELETE FROM task_leases/);
  assert.match(sql, /state='ready'/);
  assert.match(sql, /INSERT INTO issue_admin_audit/);
});

test("force complete requires a diff reference and closes the GitHub issue", async () => {
  const env = envFor(task);
  await withGithub("metis:complete", async (requests) => {
    const response = await administerIssueForIdentity("admin@from-trees.com", new Request("https://ui/api/issues/force-complete", { method: "POST", headers: { "content-type": "application/json", "Idempotency-Key": "key-2" }, body: JSON.stringify({ repository: "owner/repo", issue_number: 4, expected_updated_at: 100, confirmation: "FORCE_COMPLETE", reason: "Human accepted the diff", diff_reference: "commit:abcdef1", request_id: "request-2" }) }), env, async () => {}, "force_complete");
    assert.equal(response.status, 200);
    assert.ok(requests.some(({ body }) => body?.state === "closed" && body?.state_reason === "completed"));
  });
  assert.match(env.batches[0].map(({ sql }) => sql).join("\n"), /state='complete'/);
});
