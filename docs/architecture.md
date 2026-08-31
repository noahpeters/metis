# Architecture

## Ownership

- **GitHub:** issues, comments, labels, branches, pull requests, repository instructions, and CI are durable engineering truth.
- **Cloudflare Worker:** authenticates webhooks, runs scheduler transitions, exposes coding callbacks, and recovers expired leases.
- **D1:** operational index: task snapshots, dependencies, dispatches, leases, an operator capacity gate, pacing, retries, and events.
- **Queues:** decouple webhook receipt, analysis, coding dispatch, and bounded retry.
- **Workers AI:** summarization, sizing, advisory dependency extraction, prioritization, and status summaries. It does not implement code or decide whether a human-approved issue is Ready.
- **Codex/cloud execution:** deep repository inspection, implementation, debugging, verification, and substantive review.
- **Perplexity:** optional external research only; disabled by default.

## Scheduling path

1. GitHub signs an `issues.labeled` webhook.
2. The Worker verifies signature, repository allowlist, delivery idempotency, and `metis:ready`.
3. D1 upserts the task snapshot and Queue receives intake work.
4. Intake refetches the authoritative issue and paginated discussion, separates human decisions from Codex connector output and routine Metis status, and applies deterministic context limits that retain the newest relevant clarifications.
5. The latest human Ready signal supersedes stale prose, inferred dependencies, and earlier human-resolvable blockers. Bounded authoritative checks may identify candidate hard contradictions; unavailable evidence warns and defers without fabricating a blocker.
6. Workers AI produces structured planning metadata.
7. Only evidence-backed task contradictions enter `blocked`; task-specific approval requirements may enter `budget_blocked`. A closed provider gate and pacing exhaustion remain scheduler deferrals.
8. The scheduler checks the explicit provider gate, operator pacing, per-task limits, concurrency, and retries.
9. D1 reserves a lease and legacy estimated workload units before Codex dispatch; this estimate is never provider-capacity evidence.
10. A connector result releases the lease and moves GitHub to awaiting PR, blocked, or failed.
11. For included Codex Cloud work, a human reviews the prepared diff and clicks Create PR.
12. The signed pull-request webhook verifies the Metis task marker and moves GitHub to PR ready.
13. Repository-scoped policy marks a PR ready after checks, approvals, mergeability, and health pass; only a human may merge it.
14. Metis monitors required deployment workflows for the exact merge SHA; a failure freezes normal work and creates a bounded corrective PR chain.

## Provider boundary

Metis does not infer actual ChatGPT/Codex capacity from local workload estimates. `CODEX_DISPATCH_URL` is an explicit adapter for a supported included-capacity cloud coding launcher. If it is absent or the operator capacity gate is closed, Metis defers dispatch. Unknown provider capacity stays unknown, and there is no metered or purchased-credit fallback path.

## Trust boundaries

Issue text, model output, and repository files are untrusted. GitHub webhook signatures and callback tokens are verified. Repository access is allowlisted. Target repositories are edited only by the isolated coding runner. Metis cannot merge pull requests, push directly to the default branch, or deploy manually.
