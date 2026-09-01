import test from "node:test";
import assert from "node:assert/strict";
import { admissionDecision, claimTask, pruneSchedulerSignals, recordSchedulerDeferral, schedulerDeferral } from "../src/scheduler.mjs";

function dbWith({ health = null, capacity = { available: 1 }, window = { estimated_workload_units_used: 20, tasks_started: 1 }, active = { count: 0 } } = {}) {
  return {
    prepare(sql) {
      return {
        bind() { return this; },
        async first() {
          if (sql.startsWith("SELECT current_window_id,generation")) return null;
          if (sql.includes("repository_health")) return health;
          if (sql.includes("provider_capacity")) return capacity;
          if (sql.includes("pacing_windows")) return window;
          if (sql.includes("task_leases")) return active;
          throw new Error(`Unexpected query: ${sql}`);
        },
      };
    },
  };
}

test("estimated-workload pacing exhaustion defers Ready work without task mutation", async () => {
  const task = { id: "owner/repo#15", repository: "owner/repo", size_class: "small", attempt_count: 0 };
  const decision = await admissionDecision({ DB: dbWith() }, task);
  assert.deepEqual(decision, schedulerDeferral("workload-pacing", "Operator estimated-workload pacing limit reached."));
  assert.equal(task.attempt_count, 0);
});

test("an explicit provider gate defers without creating a task blocker", async () => {
  const decision = await admissionDecision({ DB: dbWith({ capacity: { available: 0 } }) }, { repository: "owner/repo", size_class: "small" });
  assert.equal(decision.defer, true);
  assert.equal(decision.kind, "provider");
});

test("unknown provider capacity does not turn workload estimates into provider capacity", async () => {
  const decision = await admissionDecision({ DB: dbWith({ capacity: { available: 1 }, window: { estimated_workload_units_used: 0, tasks_started: 0 } }) }, { repository: "owner/repo", size_class: "small" });
  assert.equal(decision.admitted, true);
  assert.equal(decision.estimatedWorkloadUnits, 2);
});

test("optional task-start pacing defers Ready work", async () => {
  const policy = JSON.stringify({ global: { maxTasksPerWindow: 1, maxEstimatedWorkloadUnitsPerWindow: 99 } });
  const decision = await admissionDecision({ DB: dbWith({ window: { estimated_workload_units_used: 0, tasks_started: 1 } }), METIS_POLICY_JSON: policy }, { repository: "owner/repo", size_class: "small" });
  assert.deepEqual(decision, schedulerDeferral("task-start-pacing", "Operator task-start pacing limit reached."));
});

test("scheduler signals are keyed by pacing window and cause", async () => {
  const calls = [];
  const env = { DB: { prepare: (sql) => ({ first: async () => ({ current_window_id: "window-7" }), bind: (...values) => ({ run: async () => calls.push({ sql, values }) }) }) } };
  await recordSchedulerDeferral(env, schedulerDeferral("workload-pacing", "reached"));
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /ON CONFLICT\(signal_key\)/);
  assert.equal(calls[0].values[0], "window-7:workload-pacing");
});

test("old scheduler signals are pruned at window rollover", async () => {
  const calls = [];
  const env = { DB: { prepare: (sql) => ({ run: async () => calls.push(sql) }) } };
  await pruneSchedulerSignals(env);
  assert.deepEqual(calls, ["DELETE FROM scheduler_signals WHERE window_key != (SELECT current_window_id FROM pacing_window_control WHERE singleton=1)"]);
});

test("a successful claim clears resolved signals for the current window", async () => {
  const statements = [];
  const env = {
    DB: {
      prepare(sql) {
        statements.push(sql);
        return { bind() { return this; } };
      },
      async batch(queries) { return queries; },
    },
  };
  await claimTask(env, { id: "owner/repo#15" }, { estimatedWorkloadUnits: 2, leaseSeconds: 60, maxConcurrentTasks: 1, maxTasksPerWindow: 10, maxEstimatedWorkloadUnitsPerWindow: 20 });
  assert.match(statements[0], /t\.state IN \('ready','retrying'\)/);
  assert.match(statements[0], /COUNT\(\*\) FROM task_leases/);
  assert.match(statements[0], /tasks_started/);
  assert.ok(statements.some((sql) => sql.startsWith("DELETE FROM scheduler_signals WHERE window_key=(SELECT current_window_id")));
});
