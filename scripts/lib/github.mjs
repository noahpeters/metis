import { execFileSync } from "node:child_process";

export function gh(args, options = {}) {
  return execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options }).trim();
}

export function getIssue(repository, issueNumber) {
  return JSON.parse(gh(["api", `repos/${repository}/issues/${issueNumber}`]));
}

export function setLabels(repository, issueNumber, labels) {
  gh([
    "api",
    "--method",
    "PATCH",
    `repos/${repository}/issues/${issueNumber}`,
    "--input",
    "-",
  ], { input: JSON.stringify({ labels }), stdio: ["pipe", "pipe", "pipe"] });
}

export function comment(repository, issueNumber, body) {
  gh(["issue", "comment", String(issueNumber), "--repo", repository, "--body", body]);
}
