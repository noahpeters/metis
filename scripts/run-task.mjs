import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { comment, getIssue, gh, setLabels } from "./lib/github.mjs";
import { replaceState } from "./lib/state.mjs";

const root = resolve(import.meta.dirname, "..");
const registry = JSON.parse(readFileSync(join(root, "config/repositories.json"), "utf8"));
const schema = join(root, "schemas/phase-result.schema.json");

function parseEvent() {
  if (process.env.METIS_MANUAL_REPOSITORY) {
    return {
      version: 1,
      event: "issue.ready",
      source: {
        repository: process.env.METIS_MANUAL_REPOSITORY,
        issue_number: Number(process.env.METIS_MANUAL_ISSUE_NUMBER),
      },
    };
  }
  const event = JSON.parse(readFileSync(process.env.METIS_EVENT_PATH, "utf8"));
  return event.client_payload;
}

export function validateEnvelope(envelope) {
  if (envelope?.version !== 1) throw new Error("Unsupported event version");
  if (envelope?.event !== "issue.ready") throw new Error("Unsupported event type");
  if (!registry.repositories.includes(envelope?.source?.repository)) throw new Error("Repository is not registered");
  if (!Number.isInteger(envelope?.source?.issue_number) || envelope.source.issue_number < 1) {
    throw new Error("Issue number must be a positive integer");
  }
  return envelope;
}

function runCodex(cwd, prompt, output) {
  execFileSync("codex", [
    "exec",
    "--ephemeral",
    "--approve-for-me",
    "--sandbox",
    "workspace-write",
    "--output-schema",
    schema,
    "--output-last-message",
    output,
    "-C",
    cwd,
    "-",
  ], { input: prompt, stdio: ["pipe", "inherit", "inherit"] });
  return JSON.parse(readFileSync(output, "utf8"));
}

function phasePrompt(name, issue, extra = "") {
  const instructions = readFileSync(join(root, `prompts/${name}.md`), "utf8");
  return `${instructions}\n\n# Issue #${issue.number}: ${issue.title}\n\n${issue.body || "(no body)"}\n\n${extra}`;
}

function transition(issue, nextState) {
  const labels = issue.labels.map((label) => label.name);
  setLabels(issue.repository_url.split("/repos/")[1], issue.number, replaceState(labels, nextState));
}

function block(repository, issue, phase, result) {
  transition(issue, "metis:blocked");
  comment(repository, issue.number, [
    `## Metis is blocked during ${phase}`,
    "",
    result.summary,
    "",
    `**Decision or information needed:** ${result.question || "Please clarify the issue requirements."}`,
    "",
    ...result.details.map((detail) => `- ${detail}`),
    "",
    "Reply with the missing information, then reapply `metis:ready` when the task should continue.",
  ].join("\n"));
}

function main() {
  const envelope = validateEnvelope(parseEvent());
  const repository = envelope.source.repository;
  const issueNumber = envelope.source.issue_number;
  const issue = getIssue(repository, issueNumber);
  const labels = issue.labels.map((label) => label.name);
  if (issue.state !== "open" || !labels.includes("metis:ready")) throw new Error("Issue must be open and labeled metis:ready");

  const work = mkdtempSync(join(tmpdir(), "metis-"));
  const checkout = join(work, "target");
  transition(issue, "metis:planning");
  gh(["repo", "clone", repository, checkout, "--", "--depth=50"]);

  const plan = runCodex(checkout, phasePrompt("planner", issue), join(work, "plan.json"));
  if (plan.status === "BLOCKED") return block(repository, issue, "planning", plan);
  if (process.env.METIS_DRY_RUN === "true") {
    comment(repository, issueNumber, `## Metis dry-run plan\n\n${plan.summary}\n\n${plan.details.map((x) => `- ${x}`).join("\n")}`);
    transition(issue, "metis:ready");
    return;
  }

  transition(issue, "metis:implementing");
  const implementation = runCodex(
    checkout,
    phasePrompt("implementer", issue, `# Approved plan\n${JSON.stringify(plan, null, 2)}`),
    join(work, "implementation.json"),
  );
  if (implementation.status === "BLOCKED") return block(repository, issue, "implementation", implementation);

  transition(issue, "metis:reviewing");
  const diff = execFileSync("git", ["diff", "--stat", "--", "."], { cwd: checkout, encoding: "utf8" });
  if (!diff.trim()) return block(repository, issue, "implementation", {
    summary: "The implementer completed without producing a code or documentation change.",
    question: "Should the task be clarified or closed without a pull request?",
    details: implementation.details,
  });
  const review = runCodex(
    checkout,
    phasePrompt("reviewer", issue, `# Plan\n${JSON.stringify(plan, null, 2)}\n\n# Implementer report\n${JSON.stringify(implementation, null, 2)}\n\n# Diff stat\n${diff}`),
    join(work, "review.json"),
  );
  if (review.status === "BLOCKED") return block(repository, issue, "review", review);
  if (review.status !== "ACCEPTED") return block(repository, issue, "review repair", {
    summary: "The independent review found changes that need another implementation pass. Automatic repair is not enabled in the first proof of concept.",
    question: "Should Metis proceed with the review findings below?",
    details: review.details,
  });

  const slug = issue.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48);
  const branch = `metis/${issueNumber}-${slug}`;
  execFileSync("git", ["switch", "-c", branch], { cwd: checkout, stdio: "inherit" });
  execFileSync("git", ["config", "user.name", "metis-bot"], { cwd: checkout });
  execFileSync("git", ["config", "user.email", "metis-bot@users.noreply.github.com"], { cwd: checkout });
  execFileSync("git", ["add", "--all"], { cwd: checkout, stdio: "inherit" });
  execFileSync("git", ["commit", "-m", `Implement #${issueNumber}: ${issue.title}`], { cwd: checkout, stdio: "inherit" });
  execFileSync("git", ["push", "--set-upstream", "origin", branch], { cwd: checkout, stdio: "inherit" });
  const prUrl = gh([
    "pr", "create", "--repo", repository, "--head", branch, "--base", "main",
    "--title", issue.title,
    "--body", `Closes #${issueNumber}\n\n## Metis summary\n${implementation.summary}\n\n## Independent review\n${review.summary}\n\nHuman review and target-repository CI are required before merge.`,
  ]);
  transition(issue, "metis:pr-ready");
  comment(repository, issueNumber, `Metis opened ${prUrl}. Human review and repository CI are required; Metis will not merge or deploy it.`);
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  }
}
