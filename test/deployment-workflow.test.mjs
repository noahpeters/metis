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
  assert.match(workflow, /curl --fail --silent --show-error --retry 12 --retry-all-errors --retry-delay 5 --connect-timeout 10 --max-time 15 https:\/\/metis-control-plane\.gr4gwzrfq2\.workers\.dev\/health/);
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

test("standalone proof production configuration cannot provision or bind R2", async () => {
  const { readdir } = await import('node:fs/promises');
  const files = (await readdir('infra/production')).filter(name => name.endsWith('.tf'));
  for (const file of files) assert.doesNotMatch(await readFile(`infra/production/${file}`, 'utf8'), /cloudflare_r2_bucket/);
  const config = JSON.parse(await readFile('wrangler.jsonc', 'utf8'));
  assert.equal(config.r2_buckets, undefined);
  assert.equal(config.keep_vars, true);
  assert.equal(config.queues.consumers[0].max_retries, 3);
  assert.equal(config.queues.consumers[0].dead_letter_queue, 'metis-dead-letter');
  assert.equal(config.vars.STANDALONE_DISPATCH_TOKEN, undefined);
});

test('cloud Codex runtime is private, separately provisioned and subscription-only', async()=>{
  const runtime=JSON.parse(await readFile('wrangler.codex.jsonc','utf8'));
  const main=JSON.parse(await readFile('wrangler.jsonc','utf8'));
  assert.equal(runtime.workers_dev,false);assert.equal(runtime.containers.length,1);assert.equal(runtime.containers[0].max_instances,1);
  assert.deepEqual(main.services,[{binding:'CODEX_RUNTIME',service:'metis-codex-runtime'}]);
  assert.equal(main.vars.STANDALONE_CODEX_ENABLED,undefined);
  assert.equal(runtime.keep_vars,true);assert.equal(runtime.r2_buckets,undefined);
  const source=await readFile('runtime/cloud/entrypoint.mjs','utf8');
  assert.match(source,/CODEX_SUBSCRIPTION_AUTH_JSON/);assert.match(source,/fetch\(\) \{return new Response\('Not found'/);
  const workflow=await readFile('.github/workflows/ci.yml','utf8');
  assert.ok(workflow.indexOf('npm run deploy:codex:production')<workflow.indexOf('npm run deploy:production |'));
  assert.match(workflow,/docker build --platform linux\/amd64/);
  assert.doesNotMatch(workflow,/CODEX_SUBSCRIPTION_AUTH_JSON|OPENAI_API_KEY/);
  const image=await readFile('runtime/container/Dockerfile','utf8');
  assert.match(image,/@openai\/codex@0\.163\.0/);assert.doesNotMatch(image,/ARG.*(?:AUTH|TOKEN|SECRET)|ENV.*(?:AUTH|TOKEN|SECRET)/);
});
