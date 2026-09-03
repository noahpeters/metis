import test from "node:test";
import assert from "node:assert/strict";
import { dispatchFailureClass, releaseReservationStatements, sanitizedDispatchError } from "../src/dispatch-reservations.mjs";

function recordingEnv() {
  const statements = [];
  return { statements, DB: { prepare(sql) { const statement = { sql, values: [], bind(...values) { this.values = values; return this; } }; statements.push(statement); return statement; } } };
}

test("explicit authorization and validation rejections are safe to release", () => {
  assert.equal(dispatchFailureClass({ status: 403, acceptance: "confirmed_unaccepted" }), "authorization");
  assert.equal(dispatchFailureClass({ status: 422, acceptance: "confirmed_unaccepted" }), "validation");
});

test("ambiguous network delivery requires reconciliation", () => {
  assert.equal(dispatchFailureClass(new TypeError("fetch failed")), "acceptance_unknown");
});

test("release statements are state-guarded, window-specific, and idempotently audited", () => {
  const env = recordingEnv();
  releaseReservationStatements(env, "lease-1", "authorization", "GitHub POST failed (403)");
  assert.match(env.statements[0].sql, /state='reserved'/);
  assert.match(env.statements[0].sql, /window_key=\(SELECT window_key/);
  assert.doesNotMatch(env.statements[0].sql, /estimated_workload_units_used/);
  assert.match(env.statements[2].sql, /WHERE lease_id=\? AND state='reserved'/);
  assert.match(env.statements[3].sql, /ON CONFLICT\(lease_id,operation\) DO NOTHING/);
});

test("sanitized audit errors redact credentials and bound detail", () => {
  const detail = sanitizedDispatchError(new Error(`authorization=Bearer-secret ${"x".repeat(1000)}`));
  assert.doesNotMatch(detail, /Bearer-secret/);
  assert.ok(detail.length <= 500);
});
