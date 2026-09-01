import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { buildGithubCodexComment, buildGithubCodexRevisionComment, githubCodexCapabilities } from "../src/github-codex-adapter.mjs";
import { createGithubAppJwt } from "../src/github.mjs";

test("GitHub App JWT is signed with bounded timestamps", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" });
  const jwt = await createGithubAppJwt("4772921", pem, 2_000_000_000);
  const [header, payload, signature] = jwt.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(header, "base64url")), { alg: "RS256", typ: "JWT" });
  assert.deepEqual(JSON.parse(Buffer.from(payload, "base64url")), {
    iat: 1_999_999_940,
    exp: 2_000_000_540,
    iss: "4772921",
  });
  assert.ok(signature.length > 100);
});

test("GitHub Codex capability is fail-closed by default", () => {
  assert.deepEqual(githubCodexCapabilities({}), {
    provider: "codex",
    execution: "cloud",
    billing_mode: "included_subscription",
    accepting_tasks: false,
    driver: "github_user_integration",
  });
  assert.equal(githubCodexCapabilities({ CODEX_GITHUB_INTEGRATION_ENABLED: "true" }).accepting_tasks, false);
  assert.equal(githubCodexCapabilities({
    CODEX_GITHUB_INTEGRATION_ENABLED: "true",
    GITHUB_DISPATCH_USER_TOKEN: "github_pat_test",
  }).accepting_tasks, true);
});

test("GitHub Codex task comment is idempotently marked and preserves guardrails", () => {
  const body = buildGithubCodexComment({
    repository: "owner/repo",
    issue_number: 7,
    summary: "Fix the retry edge case",
    max_workload_units: 4,
  }, "lease-123");
  assert.match(body, /metis-codex-dispatch:lease-123/);
  assert.match(body, /@codex implement this issue/);
  assert.match(body, /Repository remote: https:\/\/github.com\/owner\/repo\.git/);
  assert.match(body, /Pull-request base branch: `main`/);
  assert.match(body, /Metis-Task: owner\/repo#7/);
  assert.match(body, /Maximum estimated workload units: 4/);
  assert.doesNotMatch(body, /normalized cost units/i);
  assert.match(body, /human-applied `metis:ready` decision is authoritative/);
  assert.match(body, /already checked GitHub's structured `blocked by` relationships/);
  assert.match(body, /Missing proof, uncertainty, stale prose, inferred dependencies/);
  assert.match(body, /Do not run `git push`, use `gh`/);
  assert.match(body, /READY_FOR_PR:/);
  assert.match(body, /Never merge, deploy, or mutate production/);
  assert.match(body, /desktop and mobile screenshot evidence/);
  assert.match(body, /browser report and screenshot artifact/);
  assert.match(body, /BLOCKED:/);
});

test("GitHub Codex revision prompt is exact-head and existing-PR scoped", () => {
  const body = buildGithubCodexRevisionComment({ repository: "owner/repo", issue_number: 7, pull_request_number: 12 }, {
    baseHeadSha: "a".repeat(40), feedback: [{ path: "sum.mjs", line: 9, body: "Move this helper." }],
  }, "revision-lease");
  assert.match(body, /metis-codex-revision:revision-lease/);
  assert.match(body, new RegExp("a{40}"));
  assert.match(body, /sum\.mjs:9: Move this helper/);
  assert.match(body, /prepare a replacement pull request/);
  assert.match(body, /Do not run `git push`, use `gh`/);
  assert.match(body, /READY_FOR_PR:/);
  assert.match(body, /desktop and mobile screenshot evidence/);
  assert.match(body, /Metis-Task: owner\/repo#7/);
});
