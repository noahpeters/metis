import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

async function check(resource_changes) {
  const directory = await mkdtemp(join(tmpdir(), "metis-plan-"));
  const path = join(directory, "plan.json");
  await writeFile(path, JSON.stringify({ resource_changes }));
  return spawnSync(process.execPath, ["scripts/check-terraform-plan.mjs", path], { encoding: "utf8" });
}

test("production plan guard accepts in-place updates", async () => {
  const result = await check([{ address: "cloudflare_d1_database.metis", type: "cloudflare_d1_database", change: { actions: ["update"] } }]);
  assert.equal(result.status, 0, result.stderr);
});

test("production plan guard rejects persistent replacements", async () => {
  const result = await check([{ address: "cloudflare_queue.dispatch", type: "cloudflare_queue", change: { actions: ["delete", "create"] } }]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /cloudflare_queue\.dispatch/);
});
