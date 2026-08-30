import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { buildGithubCodexComment, githubCodexCapabilities } from "../src/github-codex-adapter.mjs";
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
    max_cost_units: 4,
  }, "lease-123");
  assert.match(body, /metis-codex-dispatch:lease-123/);
  assert.match(body, /@codex implement this issue/);
  assert.match(body, /Repository remote: https:\/\/github.com\/owner\/repo\.git/);
  assert.match(body, /Pull-request base branch: `main`/);
  assert.match(body, /Metis-Task: owner\/repo#7/);
  assert.match(body, /Do not run `git push`, use `gh`/);
  assert.match(body, /READY_FOR_PR:/);
  assert.match(body, /Never merge, deploy, or mutate production/);
  assert.match(body, /BLOCKED:/);
});
