import test from "node:test";
import assert from "node:assert/strict";
import { capacityObservation, capacityObservationStatements, providerObservation, providerObservationStatement } from "../src/provider-capacity.mjs";

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

test("provider ledger preserves missing and raw fields without inventing attribution", () => {
  const observation = providerObservation({
    provider: "codex", workspace_ref: "ws_1", provider_ref: "event_1", event_class: "usage",
    classification: "unattributed", observed_at: 100, freshness: "fresh", sanitized_status: "complete",
    total_tokens: 12.5, deduplication_key: "page:event_1", source_revision: "v1",
    correlations: { task_id: { value: "task-1", proven: false }, repository: { value: "owner/repo", proven: true } },
  });
  assert.equal(observation.total_tokens, 12.5);
  assert.equal(observation.input_tokens, null);
  assert.equal(observation.credits, null);
  assert.equal(observation.task_id, null);
  assert.equal(observation.repository, "owner/repo");
  assert.equal(observation.classification, "unattributed");
});

test("provider ledger deduplicates deliveries while retaining correction revisions", () => {
  const calls = [];
  const env = { DB: { prepare(sql) { return { bind(...values) { const call = { sql, values }; calls.push(call); return call; } }; } } };
  const base = { provider: "codex", event_class: "usage", classification: "actual", observed_at: 100, freshness: "fresh", deduplication_key: "delivery-1" };
  providerObservationStatement(env, { ...base, source_revision: "v1", total_tokens: 10 });
  providerObservationStatement(env, { ...base, source_revision: "v2", total_tokens: 9, reconciliation_state: "reconciled" });
  assert.match(calls[0].sql, /ON CONFLICT DO NOTHING/);
  const revisionIndex = calls[0].sql.slice(0, calls[0].sql.indexOf(",created_at")).split(",").indexOf("source_revision");
  assert.equal(calls[0].values[revisionIndex], "v1");
  assert.equal(calls[1].values[revisionIndex], "v2");
});

test("provider ledger records stale, unavailable, and unknown without zero values", () => {
  for (const classification of ["stale", "unavailable", "unknown"]) {
    const value = providerObservation({ provider: "codex", event_class: "capacity", classification, observed_at: 100, freshness: classification === "stale" ? "stale" : "unknown", deduplication_key: classification, source_revision: "v1" });
    assert.equal(value.total_tokens, null);
    assert.equal(value.credits, null);
  }
});

test("provider ledger rejects private payload fields", () => {
  const base = { provider: "codex", event_class: "usage", classification: "actual", observed_at: 100, freshness: "fresh", deduplication_key: "x", source_revision: "v1" };
  assert.throws(() => providerObservation({ ...base, credential: "do-not-store" }), /forbidden private field/);
  assert.throws(() => providerObservation({ ...base, derived_metrics: { source_code: "do-not-store" } }), /forbidden private field/);
});
