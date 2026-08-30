import test from "node:test";
import assert from "node:assert/strict";
import { validateEnvelope } from "../scripts/run-task.mjs";

test("accepts a registered ready event", () => {
  const event = { version: 1, event: "issue.ready", source: { repository: "noahpeters/ftops", issue_number: 12 } };
  assert.equal(validateEnvelope(event), event);
});

test("rejects an unregistered repository", () => {
  const event = { version: 1, event: "issue.ready", source: { repository: "other/repo", issue_number: 12 } };
  assert.throws(() => validateEnvelope(event), /not registered/);
});

test("rejects an invalid issue number", () => {
  const event = { version: 1, event: "issue.ready", source: { repository: "noahpeters/ftops", issue_number: 0 } };
  assert.throws(() => validateEnvelope(event), /positive integer/);
});

