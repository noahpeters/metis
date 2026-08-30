import test from "node:test";
import assert from "node:assert/strict";
import { loadPolicy, taskBudget } from "../src/config.mjs";

test("paid API and Perplexity are disabled by default", () => {
  const policy = loadPolicy();
  assert.equal(policy.providers.paid_api.enabled, false);
  assert.equal(policy.providers.perplexity.enabled, false);
  assert.equal(policy.providers.perplexity.role, "research_only");
});

test("policy overrides preserve hard task-size defaults", () => {
  const policy = loadPolicy({ global: { maxConcurrentTasks: 1 }, taskSizes: { small: { maxCostUnits: 3 } } });
  assert.equal(policy.global.maxConcurrentTasks, 1);
  assert.equal(policy.taskSizes.small.maxCostUnits, 3);
  assert.equal(policy.taskSizes.small.dispatch, "automatic");
  assert.equal(policy.taskSizes.large.dispatch, "approval_required");
});

test("a per-task override cannot exceed its size-class ceiling", () => {
  assert.equal(taskBudget(loadPolicy(), "small", 99), 4);
});
