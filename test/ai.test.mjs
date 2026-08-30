import test from "node:test";
import assert from "node:assert/strict";
import { analyzeIssue } from "../src/ai.mjs";

const task = { repository: "owner/repo", issue_number: 2, title: "Add helper", body: "Add a helper and tests." };
const analysis = {
  summary: "Add a helper and tests.",
  size: "small",
  confidence: 0.9,
  estimated_cost_units: 2,
  dependencies: [],
  readiness: "ready",
  blocker_question: null,
  priority_score: 60,
  status_summary: "Ready for implementation.",
};

test("accepts Workers AI structured response objects", async () => {
  const result = await analyzeIssue({ AI: { run: async () => ({ response: analysis }) } }, task);
  assert.deepEqual(result, analysis);
});

test("accepts Workers AI JSON response strings", async () => {
  const result = await analyzeIssue({ AI: { run: async () => ({ response: JSON.stringify(analysis) }) } }, task);
  assert.deepEqual(result, analysis);
});
