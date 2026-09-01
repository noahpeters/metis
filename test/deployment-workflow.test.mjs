import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("routine production deployment preserves secrets and deploys both Workers", async () => {
  const workflow = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  assert.doesNotMatch(workflow, /wrangler (?:versions )?secret put/);
  assert.doesNotMatch(workflow, /METIS_PROJECT_USER_TOKEN/);
  assert.match(workflow, /environment: production/);
  assert.match(workflow, /node scripts\/validate-production-deployment\.mjs[\s\S]*npm run db:migrate:production/);
  assert.match(workflow, /npm run db:migrate:production/);
  assert.match(workflow, /npm run deploy:production/);
  assert.match(workflow, /npm run deploy:ui:production/);
});

test("production deployment validation fails before mutation when configuration is missing", () => {
  const script = fileURLToPath(new URL("../scripts/validate-production-deployment.mjs", import.meta.url));
  const empty = spawnSync(process.execPath, [script], { encoding: "utf8", env: {} });
  assert.equal(empty.status, 1);
  assert.match(empty.stderr, /missing CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_ACCESS_AUDIENCE, CLOUDFLARE_ACCESS_TEAM_DOMAIN/);

  const configured = spawnSync(process.execPath, [script], {
    encoding: "utf8",
    env: Object.fromEntries([
      "CLOUDFLARE_API_TOKEN",
      "CLOUDFLARE_ACCOUNT_ID",
      "CLOUDFLARE_ACCESS_AUDIENCE",
      "CLOUDFLARE_ACCESS_TEAM_DOMAIN",
    ].map((name) => [name, "configured"])),
  });
  assert.equal(configured.status, 0, configured.stderr);
});
