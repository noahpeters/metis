# Architecture

## Ownership

- **GitHub:** issues, comments, labels, branches, pull requests, repository instructions, and CI are durable engineering truth.
- **Cloudflare Worker:** authenticates webhooks, runs scheduler transitions, exposes coding callbacks, and recovers expired leases.
- **D1:** operational index: task snapshots, dependencies, dispatches, leases, provider capacity, budgets, retries, and usage.
- **Queues:** decouple webhook receipt, analysis, coding dispatch, and bounded retry.
- **Workers AI:** summarization, sizing, dependency extraction, readiness/blocker classification, prioritization, and status summaries. It does not implement code.
- **Codex/cloud execution:** deep repository inspection, implementation, debugging, verification, and substantive review.
- **Perplexity:** optional external research only; disabled by default.

## Scheduling path

1. GitHub signs an `issues.labeled` webhook.
2. The Worker verifies signature, repository allowlist, delivery idempotency, and `metis:ready`.
3. D1 upserts the task snapshot and Queue receives intake work.
4. Workers AI produces structured planning metadata.
5. Missing information enters `blocked`; approval-required or capacity-exhausted work enters `budget_blocked`.
6. The scheduler checks provider availability, global and per-task limits, concurrency, and retries.
7. D1 reserves a lease and cost units before Codex dispatch.
8. The callback releases the lease, records usage, and moves GitHub to PR ready, blocked, or failed.

## Provider boundary

Metis does not assume a generic API key consumes included ChatGPT/Codex capacity. `CODEX_DISPATCH_URL` is an explicit adapter for a supported included-capacity cloud coding launcher. If it is absent or capacity is unavailable, Metis stops. There is no metered API fallback path.

## Trust boundaries

Issue text, model output, and repository files are untrusted. GitHub webhook signatures and callback tokens are verified. Repository access is allowlisted. Target repositories are edited only by the isolated coding runner, which may open a PR but cannot merge or deploy.
