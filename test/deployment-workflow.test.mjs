import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";

test("routine production deployment preserves secrets and deploys both Workers", async () => {
  const workflow = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  assert.doesNotMatch(workflow, /wrangler (?:versions )?secret put/);
  assert.doesNotMatch(workflow, /METIS_PROJECT_USER_TOKEN/);
  assert.match(workflow, /environment: production/);
  assert.match(workflow, /npm run db:migrate:production/);
  assert.match(workflow, /npm run deploy:production/);
  assert.match(workflow, /npm run deploy:ui:production/);
  assert.match(workflow, /terraform-plan:/);
  assert.match(workflow, /terraform-apply:/);
  assert.match(workflow, /needs: \[verify, terraform-apply\]/);
  assert.match(workflow, /environment: production/);
  assert.doesNotMatch(workflow, /TERRAFORM_STATE_ACCESS_KEY_ID|TERRAFORM_STATE_SECRET_ACCESS_KEY/);
  assert.doesNotMatch(workflow, /AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY/);
  assert.doesNotMatch(workflow, /CLOUDFLARE_ZONE_ID|CLOUDFLARE_ACCESS_TEAM_DOMAIN|CLOUDFLARE_ACCESS_AUDIENCE/);
  assert.match(workflow, /GITHUB_STEP_SUMMARY/);
  assert.doesNotMatch(workflow, /complete-production-cutover/i);
});

test("control-plane deployments retain dashboard-managed encrypted secrets", () => {
  const config = readFileSync("wrangler.jsonc", "utf8");
  assert.match(config, /"keep_vars": true/);
});

test("Access discovery uses the provider-v5 account-qualified import ID", () => {
  const source = readFileSync("infra/production/import-existing-access.mjs", "utf8");
  assert.match(source, /`accounts\/\$\{accountId\}\/\$\{matches\[0\]\.id\}`/);
});

test("administration API uses capability-bound service RPC", () => {
  const controlPlane = readFileSync("wrangler.jsonc", "utf8");
  const entrypoint = readFileSync("src/control-plane-entrypoint.mjs", "utf8");
  const uiApi = readFileSync("src/ui/api.mjs", "utf8");
  assert.match(controlPlane, /"main": "src\/control-plane-entrypoint\.mjs"/);
  assert.match(entrypoint, /extends WorkerEntrypoint/);
  assert.match(uiApi, /CONTROL_PLANE\.pacingOverview/);
  assert.doesNotMatch(uiApi, /CONTROL_PLANE\.fetch|UI_BINDING_TOKEN|X-Metis-UI-Binding/);
});
