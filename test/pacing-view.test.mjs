import assert from "node:assert/strict";
import test from "node:test";
import { derivePacingView, formatExactTime, relativeUntil } from "../ui-assets/pacing.js";

const overview = (changes = {}) => ({ semantics: "operational_capacity", pacing: { state: "available", limiting_dimension: null, task_starts: { used: 1, limit: 4 } }, work_completed: { unit: "size_points", last_1_hour: 2, last_8_hours: 7, last_24_hours: 15 }, active_tasks: { count: 0 }, executable_ready: { count: 0 }, provider_capacity: { state: "available", expected_available_at: null }, ...changes });

test("active execution keeps the available green state", () => {
  const view = derivePacingView(overview({ active_tasks: { count: 2 } }));
  assert.equal(view.tone, "active");
  assert.match(view.reason, /2 tasks/);
  assert.deepEqual([view.completed1h, view.completed8h, view.completed24h], ["2", "7", "15"]);
});

test("provider exhaustion takes precedence and reports accurate availability timing", () => {
  const timed = derivePacingView(overview({ active_tasks: { count: 1 }, provider_capacity: { state: "exhausted", expected_available_at: "2026-09-02T00:00:00.000Z" } }));
  assert.equal(timed.tone, "exhausted");
  assert.equal(timed.label, "Codex capacity exhausted");
  assert.equal(timed.expectedAvailableAt, "2026-09-02T00:00:00.000Z");
  assert.equal(timed.reenergizeAllowed, true);
  const unknown = derivePacingView(overview({ provider_capacity: { state: "exhausted", expected_available_at: null } }));
  assert.match(unknown.reason, /automatically retry capacity after 60 minutes/);
});

test("task-start pacing remains distinct from provider exhaustion", () => {
  const view = derivePacingView(overview({ pacing: { state: "exhausted", limiting_dimension: "task_starts", task_starts: { used: 4, limit: 4 } } }));
  assert.equal(view.tone, "paced");
  assert.equal(view.label, "Task-start pacing reached");
});

test("ready work is never described as idle and explains verified waiting", () => {
  const view = derivePacingView(overview({ executable_ready: { count: 3 }, provider_capacity: { state: "unavailable" } }));
  assert.equal(view.tone, "waiting");
  assert.equal(view.warning, true);
  assert.equal(view.nudgeAllowed, true);
  assert.match(view.reason, /Provider capacity/);
});

test("nudge is restricted to the Ready-work waiting state", () => {
  assert.equal(derivePacingView(overview()).nudgeAllowed, false);
  assert.equal(derivePacingView(overview({ active_tasks: { count: 1 }, executable_ready: { count: 3 } })).nudgeAllowed, false);
  assert.equal(derivePacingView(overview({ executable_ready: { count: 1 } })).nudgeAllowed, true);
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
