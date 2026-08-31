import test from "node:test";
import assert from "node:assert/strict";
import { buildCodexTask, validateCapabilities } from "../src/codex-dispatch.mjs";

test("accepts only cloud Codex with included subscription billing", () => {
  assert.equal(validateCapabilities({ provider: "codex", execution: "cloud", billing_mode: "included_subscription", accepting_tasks: true }).provider, "codex");
  assert.throws(() => validateCapabilities({ provider: "codex", execution: "cloud", billing_mode: "api_metered", accepting_tasks: true }), /billing mode is not allowed/);
  assert.throws(() => validateCapabilities({ provider: "codex", execution: "local", billing_mode: "included_subscription", accepting_tasks: true }), /not a Codex cloud/);
});

test("task envelope forbids merge, deployment, and production mutation", () => {
  const task = buildCodexTask({ id: "owner/repo#1", repository: "owner/repo", issue_number: 1, summary: "work", max_workload_units: 4 }, "lease-1", "https://metis.example/callback");
  assert.equal(task.execution_envelope.merge, "forbidden");
  assert.equal(task.execution_envelope.deployment, "forbidden");
  assert.equal(task.execution_envelope.production_mutation, "forbidden");
  assert.equal(task.execution_envelope.max_workload_units, 4);
});
