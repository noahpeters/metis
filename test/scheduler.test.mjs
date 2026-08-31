import test from "node:test";
import assert from "node:assert/strict";
import { admissionDecision, recordSchedulerDeferral, schedulerDeferral } from "../src/scheduler.mjs";

function dbWith({ health = null, capacity = { available: 1, remaining_units: 20 }, window = { cost_units_used: 20, tasks_started: 1 }, active = { count: 0 } } = {}) {
  return {
    prepare(sql) {
      return {
        bind() { return this; },
        async first() {
          if (sql.includes("repository_health")) return health;
          if (sql.includes("provider_capacity")) return capacity;
          if (sql.includes("budget_windows")) return window;
          if (sql.includes("task_leases")) return active;
          throw new Error(`Unexpected query: ${sql}`);
        },
      };
    },
  };
}

test("global budget exhaustion defers a Ready task without task mutation", async () => {
  const task = { id: "owner/repo#15", repository: "owner/repo", size_class: "small", attempt_count: 0 };
  const decision = await admissionDecision({ DB: dbWith() }, task);
  assert.deepEqual(decision, schedulerDeferral("cost-budget", "Global cost-unit budget exhausted."));
  assert.equal(task.attempt_count, 0);
});

test("provider exhaustion is scheduler state rather than a task blocker", async () => {
  const task = { repository: "owner/repo", size_class: "small" };
  const decision = await admissionDecision({ DB: dbWith({ capacity: { available: 0, remaining_units: 0 } }) }, task);
  assert.equal(decision.defer, true);
  assert.equal(decision.kind, "provider");
});

test("scheduler signals are keyed by budget window and cause", async () => {
  const calls = [];
  const env = { DB: { prepare: (sql) => ({ bind: (...values) => ({ run: async () => calls.push({ sql, values }) }) }) } };
  await recordSchedulerDeferral(env, schedulerDeferral("cost-budget", "exhausted"));
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /ON CONFLICT\(signal_key\)/);
  assert.match(calls[0].values[0], /^\d{4}-\d{2}-\d{2}:cost-budget$/);
});
