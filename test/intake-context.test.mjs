import test from "node:test";
import assert from "node:assert/strict";
import { buildIntakeInvestigation, fetchIssueDiscussion, selectDiscussion } from "../src/intake-context.mjs";

const issue = { id: 9, number: 6, title: "Configure project", body: "Need the project ID", updated_at: "2026-01-01" };
const comment = (id, body, options = {}) => ({ id, body, created_at: `2026-01-${String(id).padStart(2, "0")}`, updated_at: `2026-01-${String(id).padStart(2, "0")}`, user: { login: options.login || "human", type: options.type || "User" }, performed_via_github_app: options.app ? { slug: options.app } : undefined });

test("preserves chronology and attribution while segregating status bots", () => {
  const result = selectDiscussion(issue, [
    comment(1, "Initial plan"),
    comment(2, "## Metis is blocked", { login: "metis[bot]", type: "Bot" }),
    comment(3, "Connector output", { login: "chatgpt-codex-connector[bot]", type: "Bot", app: "chatgpt-codex-connector" }),
    comment(4, "Later clarification"),
  ]);
  assert.deepEqual(result.comments.map(({ id, source }) => [id, source]), [[1, "human"], [3, "codex-connector"], [4, "human"]]);
  assert.equal(result.metis_status_count, 1);
});

test("deterministic context pressure prefers newest relevant decisions", () => {
  const result = selectDiscussion(issue, [comment(1, "old"), comment(2, "new answer")], { comments: 500, characters: 10 });
  assert.deepEqual(result.comments.map((item) => [item.id, item.body]), [[2, "new answer"]]);
  assert.equal(result.omitted_relevant_count, 1);
});

test("issue 6 project ID is discovered from human discussion and checked against configuration", () => {
  const discussion = selectDiscussion(issue, [comment(1, "The stable node is PVT_kwHOAA6eJM4Bh81k.")]);
  const result = buildIntakeInvestigation({ id: "noahpeters/metis#6" }, discussion, JSON.stringify({ projectId: "PVT_kwHOAA6eJM4Bh81k" }));
  assert.equal(result.project.evidence, "consistent");
  assert.deepEqual(result.project.human_mentioned_ids, ["PVT_kwHOAA6eJM4Bh81k"]);
  assert.equal(result.bounds.external_requests, 0);
});

test("investigation reports unavailable permissions/configuration and conflicting evidence", () => {
  const discussion = selectDiscussion(issue, [comment(1, "Use PVT_humanDecision")]);
  assert.equal(buildIntakeInvestigation({}, discussion, "").project.policy_status, "unavailable");
  const conflict = buildIntakeInvestigation({}, discussion, JSON.stringify({ projectId: "PVT_authoritativeConfig" }));
  assert.equal(conflict.project.evidence, "conflicting");
});

test("fetches multi-page discussions in stable ascending pages", async (context) => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (!String(url).includes("/comments")) return new Response(JSON.stringify(issue));
    const page = Number(new URL(url).searchParams.get("page"));
    return new Response(JSON.stringify(page === 1 ? Array.from({ length: 100 }, (_, index) => comment(index + 1, `c${index + 1}`)) : [comment(101, "last")]));
  };
  context.after(() => { globalThis.fetch = originalFetch; });
  const result = await fetchIssueDiscussion({ GITHUB_TOKEN: "redacted" }, "owner/repo", 6);
  assert.equal(result.pages_fetched, 2);
  assert.equal(result.fetched_comment_count, 101);
  assert.match(calls[1], /page=1&sort=created&direction=asc/);
  assert.match(calls[2], /page=2&sort=created&direction=asc/);
});

test("comment-fetch failures propagate so intake can fail closed", async (context) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => String(url).includes("/comments") ? new Response("denied", { status: 403 }) : new Response(JSON.stringify(issue));
  context.after(() => { globalThis.fetch = originalFetch; });
  await assert.rejects(() => fetchIssueDiscussion({ GITHUB_TOKEN: "redacted" }, "owner/repo", 6), /failed \(403\)/);
});
