# Metis

Metis is a deliberately small orchestration layer for AI-assisted software development.

ChatGPT remains the design room. GitHub Issues remain each project's task system of record. When an issue receives the `metis:ready` label, a hosted GitHub Actions runner performs a sequential plan → implement → review loop and opens a pull request. If the implementer cannot safely continue, it stops, marks the issue `metis:blocked`, and asks one concrete question.

Metis does not merge pull requests, deploy applications, or require a user-owned computer to remain online.

## Status

This repository contains the first proof of concept:

- a documented issue state machine and event envelope;
- a central `repository_dispatch` workflow;
- a Node runner that coordinates GitHub and Codex CLI;
- structured planner, implementer, reviewer, and blocker outputs;
- a thin target-repository adapter and `.metis.yml` example;
- tests for state transitions and event validation.

The first live run is intentionally deferred until repository secrets and GitHub authentication are configured.

## How it works

```text
ChatGPT design conversation
          ↓
Issue in target repository
          ↓ add metis:ready
Thin target workflow sends repository_dispatch
          ↓
Metis GitHub Actions runner
          ↓
plan → implement → verify → review
          ├── blocked → issue question + metis:blocked
          └── accepted → branch + pull request + metis:pr-ready
```

See [docs/architecture.md](docs/architecture.md), [docs/states-and-labels.md](docs/states-and-labels.md), and [docs/event-model.md](docs/event-model.md).

## Target repository contract

Each target repository stays thin:

1. Copy `examples/target-repo/.github/workflows/metis.yml` into the target repository.
2. Copy and edit `examples/target-repo/.metis.yml`.
3. Add or refine `AGENTS.md` with repository-specific safety, verification, and deployment instructions.
4. Add a target-repository secret named `METIS_DISPATCH_TOKEN` that can dispatch events to this repository.
5. Add the labels listed in `config/labels.json`.

Metis itself requires:

- `OPENAI_API_KEY` for Codex CLI;
- `METIS_GITHUB_TOKEN` with read/write access to issues, contents, and pull requests in registered target repositories.

For a production version, replace long-lived personal tokens with a narrowly installed GitHub App.

## Local verification

```sh
npm run verify
```

## Guardrails

- A human must add `metis:ready`.
- The runner refuses unregistered repositories.
- The implementer may edit only the checked-out target repository.
- Metis never merges or deploys.
- The target repository's own CI is authoritative.
- A blocked task stops immediately and records the exact missing decision or information.

