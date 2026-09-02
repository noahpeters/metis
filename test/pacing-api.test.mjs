import assert from "node:assert/strict";
import test from "node:test";
import { nudgeReadyWorkForIdentity, pacingOverview } from "../src/pacing-api.mjs";

const headers = { "X-Metis-Verified-Email": "admin@from-trees.com" };

function overviewEnv({ provider = null, completed = [] } = {}) {
  const rows = [
    { window_key: "window-1", generation: 1, started_at: 1_700_000_000, tasks_started: 2 },
    provider,
    { results: [{ id: "o/r#1", repository: "o/r", issue_number: 1, state: "running" }] },
    { count: 4 },
    { last_successful_at: 1_700_000_010 },
    { results: completed },
  ];
  return { DB: { prepare: () => ({ first: async () => rows.shift(), all: async () => rows.shift(), bind() { return this; } }) } };
}

test("overview reports rolling completed size points without workload units", async () => {
  const now = Math.floor(Date.now() / 1000);
  const env = overviewEnv({ completed: [
    { created_at: now - 100, estimated_workload_units: 2, size_class: "small" },
    { created_at: now - 7200, estimated_workload_units: 5, size_class: "medium" },
    { created_at: now - 40000, estimated_workload_units: 12, size_class: "large" },
  ] });
  const response = await pacingOverview(new Request("https://cp/internal/ui/pacing", { headers }), env);
  const body = await response.json();
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(body.semantics, "operational_capacity");
  assert.deepEqual(body.work_completed, { unit: "size_points", last_1_hour: 2, last_8_hours: 7, last_24_hours: 19 });
  assert.equal(Object.hasOwn(body.pacing, "estimated_workload_units"), false);
  assert.equal(body.active_tasks.references[0].id, "o/r#1");
  assert.equal(body.executable_ready.count, 4);
});

test("provider exhaustion exposes only provider-supplied availability evidence", async () => {
  const reset = Math.floor(Date.now() / 1000) + 3600;
  let response = await pacingOverview(new Request("https://cp/internal/ui/pacing", { headers }), overviewEnv({ provider: { available: 0, resets_at: reset, updated_at: reset - 60, metadata_json: JSON.stringify({ outcome: "exhausted", limit_reason: "weekly limit" }) } }));
  let body = await response.json();
  assert.equal(body.provider_capacity.state, "exhausted");
  assert.equal(body.provider_capacity.expected_available_at, new Date(reset * 1000).toISOString());
  assert.equal(body.provider_capacity.limit_reason, "weekly limit");

  response = await pacingOverview(new Request("https://cp/internal/ui/pacing", { headers }), overviewEnv({ provider: { available: 0, resets_at: null, updated_at: reset - 60, metadata_json: "{}" } }));
  body = await response.json();
  assert.deepEqual(body.provider_capacity, { state: "unavailable", observed_at: new Date((reset - 60) * 1000).toISOString(), expected_available_at: null, limit_reason: null });
});

test("nudge re-authorizes identity and runs exactly one fresh scheduler reconciliation", async () => {
  let calls = 0;
  let response = await nudgeReadyWorkForIdentity("attacker@example.com", async () => { calls += 1; });
  assert.equal(response.status, 401);
  assert.equal(calls, 0);
  response = await nudgeReadyWorkForIdentity("admin@from-trees.com", async () => { calls += 1; return { observed: 4, admitted: 1 }; });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { reconciled: true, observed: 4, admitted: 1 });
  assert.equal(calls, 1);
});

test("nudge reports a failed reconciliation instead of claiming success", async () => {
  const response = await nudgeReadyWorkForIdentity("admin@from-trees.com", async () => null);
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, "reconciliation_failed");
});
