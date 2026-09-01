import assert from "node:assert/strict";
import test from "node:test";
import { derivePacingView, formatExactTime, relativeUntil } from "../ui-assets/pacing.js";

const overview = (changes = {}) => ({ semantics: "estimated_local_pacing", pacing: { state: "available", limiting_dimension: null, estimated_workload_units: { used: 3, limit: 8 }, task_starts: { used: 1, limit: 4 } }, active_tasks: { count: 0 }, executable_ready: { count: 0 }, provider_capacity: { state: "available" }, ...changes });

test("active execution takes precedence over exhausted pacing", () => {
  const view = derivePacingView(overview({ active_tasks: { count: 2 }, pacing: { ...overview().pacing, state: "exhausted", limiting_dimension: "task_starts" } }));
  assert.equal(view.tone, "active");
  assert.match(view.reason, /2 tasks/);
});

test("exhaustion names task-start and workload dimensions", () => {
  for (const [dimension, label] of [["task_starts", "Task-start"], ["estimated_workload_units", "Workload-unit"]]) {
    const view = derivePacingView(overview({ pacing: { ...overview().pacing, state: "exhausted", limiting_dimension: dimension } }));
    assert.match(view.label, new RegExp(label));
  }
});

test("ready work is never described as idle and explains verified waiting", () => {
  const view = derivePacingView(overview({ executable_ready: { count: 3 }, provider_capacity: { state: "unavailable" } }));
  assert.equal(view.tone, "waiting");
  assert.equal(view.warning, true);
  assert.match(view.reason, /Provider capacity/);
});

test("missing freshness produces an honest unknown state", () => {
  assert.equal(derivePacingView(overview({ executable_ready: { count: null } })).tone, "unknown");
  assert.equal(derivePacingView(null).tone, "unknown");
});

test("time helpers preserve exact UTC boundaries and friendly duration", () => {
  assert.match(formatExactTime("2026-09-02T00:00:00.000Z"), /Sep 2, 2026/);
  assert.match(relativeUntil("2026-09-02T00:00:00.000Z", Date.parse("2026-09-01T22:00:00.000Z")), /2 hours/);
  assert.equal(formatExactTime(null), "unknown time");
});
