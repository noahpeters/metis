import test from "node:test";
import assert from "node:assert/strict";
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
});

test("production recovery discovers the legacy Access application before applying its wildcard destination", async () => {
  const importer = await readFile(new URL("../infra/production/import-existing-access.mjs", import.meta.url), "utf8");
  assert.match(importer, /new Set\(\[domain, "metis\.from-trees\.com"\]\)/);
  assert.match(importer, /discoverableDomains\.has\(application\.domain\)/);
});
