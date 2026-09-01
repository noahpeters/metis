# Architecture

## Authoritative lifecycle reconciliation

GitHub issue and pull-request identities, the exact `Metis-Task: owner/repo#issue`
marker, the human merge SHA, and configured Actions workflow runs for that exact
SHA outrank stale runtime rows and leases. The scheduled reconciler scans a
bounded set of nonterminal tasks, discovers missed pull requests with bounded
pagination, and appends keyed audit observations before repairing lifecycle
state. It fails closed and posts one operator-visible error when evidence is
ambiguous, inaccessible, or pagination is incomplete.

A merged pull request remains deploying until the latest attempt of every
configured deployment workflow succeeds for its merge SHA. Failure, cancellation,
timeout, or absence beyond the observation window enters the existing bounded
recovery path. Completion removes stale leases, restores repository health,
mirrors the complete label, records one evidence comment, and closes the issue.
Neither a green PR check nor a workflow for another commit can complete a task.

## Ownership

- **GitHub:** issues, comments, labels, branches, pull requests, repository instructions, and CI are durable engineering truth.
- **Cloudflare Worker:** authenticates webhooks, runs scheduler transitions, exposes coding callbacks, and recovers expired leases.
- **D1:** operational index: task snapshots, dependencies, dispatches, leases, an operator capacity gate, pacing, retries, and events.
- **Queues:** decouple webhook receipt, analysis, coding dispatch, and bounded retry.
- **Workers AI:** summarization, sizing, advisory dependency extraction, prioritization, and status summaries. It does not implement code or decide whether a human-approved issue is Ready.
- **Codex/cloud execution:** deep repository inspection, implementation, debugging, verification, and substantive review.
- **Perplexity:** optional external research only; disabled by default.

## Scheduling path

1. A scheduled reconciliation reads every page of Metis Main Project in position order, validates the configured field and option IDs, and expands GitHub's authoritative parent/sub-issue relationships depth-first. Top-level Project position orders queue groups; GitHub's sub-issue order determines sibling priority, including nested and cross-repository children. A child also present as a flat Project item is emitted only under its nearest represented ancestor, while an unparented issue keeps its flat position.
2. Only open, accessible, non-archived, allowlisted issues with `Execution owner=Metis` and `Status=Ready` are eligible; removed or changed items are not admitted.
3. D1 records each reconciliation, its page checkpoint, outcome, and a redacted operator-visible failure reason before an eligible issue receives intake work. Successful snapshots include each issue's observed root position, ancestry, sibling position, and reconciliation time for audit; these observations are not durable issue identity.
4. Inaccessible or disallowed hierarchy data, incomplete pagination, cycles, conflicting ancestry, or excessive nesting fail the entire reconciliation closed. Ready intent is preserved, and admission consumes no attempt, lease, reservation, provider capacity, or pacing allowance until a later scheduled reconciliation succeeds.
5. Intake refetches the authoritative issue and paginated discussion, separates human decisions from Codex connector output and routine Metis status, and applies deterministic context limits that retain the newest relevant clarifications.
6. Project Ready is the human authority signal. Running work remains D1-authoritative: later Project edits or removal do not implicitly cancel it. Bounded authoritative checks may identify candidate hard contradictions; unavailable evidence warns and defers without fabricating a blocker.
7. Workers AI produces structured planning metadata.
8. Only evidence-backed task contradictions enter `blocked`; task-specific approval requirements may enter `budget_blocked`. A closed provider gate and pacing exhaustion remain scheduler deferrals.
9. The scheduler checks the explicit provider gate, operator pacing, per-task limits, concurrency, and retries.
10. D1 reserves a lease and legacy estimated workload units before Codex dispatch; this estimate is never provider-capacity evidence.
11. A connector result releases the lease and moves GitHub to awaiting PR, blocked, or failed.
12. For included Codex Cloud work, a human reviews the prepared diff and clicks Create PR.
13. The signed pull-request webhook verifies the Metis task marker and moves GitHub to PR ready.
14. Repository-scoped policy marks a PR ready after checks, approvals, mergeability, and health pass; only a human may merge it.
15. Metis monitors required deployment workflows for the exact merge SHA; a failure freezes normal work and creates a bounded corrective PR chain.

## Provider boundary

Metis does not infer actual ChatGPT/Codex capacity from local workload estimates. `CODEX_DISPATCH_URL` is an explicit adapter for a supported included-capacity cloud coding launcher. If it is absent or the operator capacity gate is closed, Metis defers dispatch. Unknown provider capacity stays unknown, and there is no metered or purchased-credit fallback path.

## Trust boundaries

Issue text, model output, and repository files are untrusted. GitHub webhook signatures and callback tokens are verified. Repository access is allowlisted. Target repositories are edited only by the isolated coding runner. Metis cannot merge pull requests, push directly to the default branch, or deploy manually.
