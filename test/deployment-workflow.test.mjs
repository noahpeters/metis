import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("routine staging deployment preserves existing Worker secrets", async () => {
  const workflow = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  assert.doesNotMatch(workflow, /wrangler (?:versions )?secret put/);
  assert.doesNotMatch(workflow, /METIS_PROJECT_USER_TOKEN/);
  assert.match(workflow, /npm run db:migrate:staging/);
  assert.match(workflow, /npm run deploy:staging/);
});
