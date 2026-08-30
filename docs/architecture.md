# Architecture

## Responsibilities

### ChatGPT

The planning and design conversation UI. It helps turn an initial request into a well-formed GitHub issue containing context, decisions, rejected alternatives, acceptance criteria, and open questions. Chat is not runtime state.

### Target GitHub repository

Owns its issues, branches, pull requests, CI, and repository-specific instructions. An issue becomes executable only when a human applies `metis:ready`.

### Metis repository

Owns the generic state machine, prompts, event validation, provider invocation, and GitHub coordination. It does not own project tasks and does not copy target-repository knowledge into a central database.

### GitHub Actions

Provides ephemeral hosted execution. No user machine or persistent Metis server is required for the proof of concept.

### Codex CLI

Runs three separate, sequential roles:

1. Planner: reads the issue and repository, then returns a bounded plan or blocker.
2. Implementer: applies the plan and verifies the work, or returns a blocker.
3. Reviewer: compares the issue, plan, diff, and verification evidence; it accepts, requests one repair pass, or blocks.

These are isolated invocations, not a multi-agent framework.

## Trust boundaries

- Issue text and repository files are untrusted inputs to the model.
- Repository registration is an explicit allowlist.
- GitHub tokens are scoped to the minimum necessary repositories and permissions.
- The target repository is checked out into an ephemeral runner.
- The agent cannot merge or deploy.
- A pull request and target CI provide the human-review boundary.

## Initial authentication

The proof of concept uses repository secrets because they are easy to understand and operate. A production hardening milestone replaces cross-repository personal access tokens with a GitHub App that has narrowly scoped installations and short-lived tokens.

## Deliberately postponed

- parallel workers;
- autonomous task decomposition into new issues;
- persistent vector memory;
- model routing and multiple providers;
- automatic merging;
- a custom task-management UI;
- a continuously running webhook service.

