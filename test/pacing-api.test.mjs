import assert from "node:assert/strict";
import test from "node:test";
import { pacingOverview, resetPacingWindow, RESET_CONFIRMATION } from "../src/pacing-api.mjs";

const headers = { "X-Metis-Verified-Email": "admin@from-trees.com", "X-Metis-UI-Binding": "secret" };

test("overview distinguishes local estimates from unknown provider state and never caches", async () => {
  const rows = [
    { window_key: "window-1", generation: 1, started_at: 1_700_000_000, estimated_workload_units_used: 3, tasks_started: 2 },
    null,
    { results: [{ id: "o/r#1", repository: "o/r", issue_number: 1, state: "running" }] },
    { count: 4 },
    { last_successful_at: 1_700_000_010 },
  ];
  const env = { UI_BINDING_TOKEN: "secret", DB: { prepare: () => ({ first: async () => rows.shift(), all: async () => rows.shift(), bind() { return this; } }) } };
  const response = await pacingOverview(new Request("https://cp/internal/ui/pacing", { headers }), env);
  const body = await response.json();
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(body.semantics, "estimated_local_pacing");
  assert.deepEqual(body.provider_capacity, { state: "unknown", observed_at: null, resets_at: null });
  assert.equal(body.active_tasks.references[0].id, "o/r#1");
  assert.equal(body.executable_ready.count, 4);
});

test("reset requires fresh binding authorization and explicit confirmation", async () => {
  const env = { UI_BINDING_TOKEN: "secret" };
  let response = await resetPacingWindow(new Request("https://cp/reset", { method: "POST", body: "{}" }), env, async () => {});
  assert.equal(response.status, 401);
  response = await resetPacingWindow(new Request("https://cp/reset", { method: "POST", headers: { ...headers, "Idempotency-Key": "key" }, body: "{}" }), env, async () => {});
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, "confirmation_required");
});

test("an idempotent reset returns immutable audit evidence without reconciling twice", async () => {
  let reconciled = 0;
  const audit = { source_window_id: "window-1", new_window_id: "window-2", created_at: 1_700_000_000 };
  const env = { UI_BINDING_TOKEN: "secret", DB: { prepare: () => ({ bind() { return this; }, first: async () => audit }) } };
  const request = new Request("https://cp/reset", { method: "POST", headers: { ...headers, "content-type": "application/json", "Idempotency-Key": "same-key" }, body: JSON.stringify({ confirmation: RESET_CONFIRMATION, expected_window_id: "window-1", request_id: "request-1", reason: "Operator-requested retry" }) });
  const response = await resetPacingWindow(request, env, async () => { reconciled += 1; });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).duplicate, true);
  assert.equal(reconciled, 0);
});
