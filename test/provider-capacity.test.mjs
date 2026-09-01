import test from "node:test";
import assert from "node:assert/strict";
import { capacityObservation, capacityObservationStatements } from "../src/provider-capacity.mjs";

test("capacity evidence preserves only provider-supplied exhaustion fields", () => {
  assert.deepEqual(capacityObservation({ capacity_outcome: "exhausted", observed_at: 20, reset_at: 30, limit_reason: "weekly limit", comment_url: "https://github.test/1" }), {
    outcome: "exhausted", observed_at: 20, reset_at: 30, limit_reason: "weekly limit",
    evidence: { comment_url: "https://github.test/1", reason: null, task_url: null },
  });
  assert.equal(capacityObservation({ capacity_outcome: "unavailable", observed_at: 20, reset_at: 30, limit_reason: "not capacity" }).reset_at, null);
});

test("capacity observations are idempotent and only authoritative outcomes update the gate", () => {
  const calls = [];
  const env = { DB: { prepare(sql) { const call = { sql, values: [] }; calls.push(call); return { bind(...values) { call.values = values; return call; } }; } } };
  assert.equal(capacityObservationStatements(env, 7, { capacity_outcome: "unknown", observed_at: 20, comment_id: "9" }).length, 1);
  assert.match(calls[0].sql, /ON CONFLICT\(provider,evidence_key\) DO NOTHING/);
  assert.equal(calls[0].values[1], "github-comment:9");

  calls.length = 0;
  assert.equal(capacityObservationStatements(env, 7, { capacity_outcome: "accepted", observed_at: 21, comment_id: "10" }).length, 2);
  assert.match(calls[1].sql, /updated_at<=\?/);
  assert.deepEqual(calls[1].values.slice(0, 2), [1, null]);
});
