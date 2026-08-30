import test from "node:test";
import assert from "node:assert/strict";
import { assertTransition, replaceState } from "../scripts/lib/state.mjs";

test("ready can transition to planning", () => {
  assert.doesNotThrow(() => assertTransition("metis:ready", "metis:planning"));
});

test("ready cannot skip directly to pull request ready", () => {
  assert.throws(() => assertTransition("metis:ready", "metis:pr-ready"));
});

test("replaceState preserves non-Metis labels", () => {
  assert.deepEqual(replaceState(["bug", "metis:ready"], "metis:planning"), ["bug", "metis:planning"]);
});

test("budget-blocked is a first-class resumable state", () => {
  assert.doesNotThrow(() => assertTransition("metis:ready", "metis:budget-blocked"));
  assert.doesNotThrow(() => assertTransition("metis:budget-blocked", "metis:ready"));
});

test("awaiting PR creation is a first-class human checkpoint", () => {
  assert.doesNotThrow(() => assertTransition("metis:implementing", "metis:awaiting-pr"));
  assert.doesNotThrow(() => assertTransition("metis:awaiting-pr", "metis:pr-ready"));
});

test("merge and deployment recovery are explicit guarded transitions", () => {
  assert.doesNotThrow(() => assertTransition("metis:pr-ready", "metis:reviewing"));
  assert.doesNotThrow(() => assertTransition("metis:reviewing", "metis:merge-ready"));
  assert.doesNotThrow(() => assertTransition("metis:merge-ready", "metis:merging"));
  assert.doesNotThrow(() => assertTransition("metis:merging", "metis:deploying"));
  assert.doesNotThrow(() => assertTransition("metis:deploying", "metis:recovery"));
  assert.doesNotThrow(() => assertTransition("metis:deploying", "metis:complete"));
});
