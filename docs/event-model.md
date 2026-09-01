# Event model

## GitHub intake

Metis receives native GitHub App webhooks at `POST /webhooks/github`. `X-GitHub-Delivery` is the idempotency key. Before lifecycle handling, Metis stores the normalized event in D1 and advances its delivery through `received`, `queued`, `processing`, `completed`, or `failed`. A retry is considered a duplicate only after completion; incomplete deliveries are resumed on retry and bounded scheduled restart reconciliation. Lifecycle handlers remain idempotent against stable task, PR, SHA, workflow, and transition identities.

## Internal Queue messages

```json
{ "type": "intake", "taskId": "noahpeters/ftops#123" }
{ "type": "dispatch", "taskId": "noahpeters/ftops#123" }
```

D1 is read on every delivery, so stale payload data cannot override scheduler state.

## Codex connector results

An official `chatgpt-codex-connector` issue comment beginning with `READY_FOR_PR:` is conclusive acceptance and completion evidence for the current dispatch. It atomically moves either `pending_connector_ack` or `running` to `awaiting_pr_creation`, records when the connector omitted a separate acknowledgment, releases the matching lease, and prompts a human to review the linked Codex task and click **Create PR**. A dispatch marker, when supplied, must match the current lease; stale attempts are rejected. Duplicate results are idempotent, and lease expiration cannot demote the completed handoff. A comment beginning with `BLOCKED:` releases the lease and preserves the concrete blocker.

The prepared pull-request body must include `Metis-Task: owner/repository#issue`. A signed `pull_request.opened` webhook with that exact marker advances only an `awaiting_pr_creation` task. Metis binds that PR as opened without changing its owner or recreating it.

## Merge and deployment lifecycle

Signed `pull_request`, `pull_request_review`, and `check_suite` events re-evaluate merge readiness. Metis requires the configured number of current human approvals, a mergeable non-draft PR to the default branch, no repository recovery lock, and successful checks when `requiredChecks` is enabled. A repository that verifies only after merge may explicitly set `requiredChecks:false`; its named deployment workflows remain mandatory. Metis then marks the task `merge-ready` and waits for a human merge.

A signed `pull_request_review.submitted` event with `changes_requested` queues a budgeted revision against the exact current head. Metis gathers inline feedback and invokes the official Codex connector from the original issue. If the connector updates the existing branch, Metis reconciles through the changed-head `pull_request.synchronize` event and preserves the PR discussion. If the connector produces a replacement through the human Create PR handoff, Metis closes the superseded PR and binds the replacement without changing its ownership. Both paths require fresh human approval, resolved review threads, and a human merge.

If Codex Cloud omits the prepared `Metis-Task` marker from a replacement PR, Metis may claim it only when exactly one recent task in that repository is awaiting a revision PR and the candidate is a same-repository, human-authored `codex/*` branch containing a Codex task link. Ambiguous, forked, stale, bot-authored, or unrelated PRs remain unclaimed.

A merged `pull_request.closed` event records the exact merge SHA and locks the repository in `deploying`. Signed `workflow_run.completed` events count only when both the SHA and configured workflow name match. All required workflows must succeed before the task becomes `complete`.

A failed required workflow moves the repository to `recovery`, freezes normal dispatch, and creates one idempotent high-priority corrective task for that failing SHA. The repair must travel through another marked pull request and the same merge/deployment gates. Recovery stops at the configured attempt limit and becomes `recovery_blocked`; no paid API fallback, direct default-branch push, forced merge, or manual deployment is attempted.

## Coding callback

The authenticated callback reports `awaiting_pr_creation`, `completed` with a PR URL and usage, `blocked` with one concrete question, or `failed` with a bounded summary. Provider token data that is unavailable remains null rather than being inferred.
