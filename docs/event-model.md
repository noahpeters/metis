# Event model

## GitHub intake

Metis receives native GitHub App webhooks at `POST /webhooks/github`. It accepts only signed `issues.labeled` events whose label is `metis:ready` and repository is allowlisted. `X-GitHub-Delivery` is the idempotency key.

## Internal Queue messages

```json
{ "type": "intake", "taskId": "noahpeters/ftops#123" }
{ "type": "dispatch", "taskId": "noahpeters/ftops#123" }
```

D1 is read on every delivery, so stale payload data cannot override scheduler state.

## Codex connector results

An official `chatgpt-codex-connector` issue comment beginning with `READY_FOR_PR:` moves the task to `awaiting_pr_creation`, releases its lease, and prompts a human to review the linked Codex task and click **Create PR**. A comment beginning with `BLOCKED:` releases the lease and preserves the concrete blocker.

The prepared pull-request body must include `Metis-Task: owner/repository#issue`. A signed `pull_request.opened` or `pull_request.reopened` webhook with that exact repository marker advances only an `awaiting_pr_creation` task to `pr_ready`.

## Merge and deployment lifecycle

Signed `pull_request`, `pull_request_review`, and `check_suite` events re-evaluate guarded auto-merge. Each repository must explicitly opt in through `METIS_LIFECYCLE_POLICY_JSON`. Metis requires successful checks, the configured number of current approvals, a mergeable non-draft PR to the default branch, and no repository recovery lock. It then enables GitHub native auto-merge; it never calls the direct merge endpoint.

A merged `pull_request.closed` event records the exact merge SHA and locks the repository in `deploying`. Signed `workflow_run.completed` events count only when both the SHA and configured workflow name match. All required workflows must succeed before the task becomes `complete`.

A failed required workflow moves the repository to `recovery`, freezes normal dispatch, and creates one idempotent high-priority corrective task for that failing SHA. The repair must travel through another marked pull request and the same merge/deployment gates. Recovery stops at the configured attempt limit and becomes `recovery_blocked`; no paid API fallback, direct default-branch push, forced merge, or manual deployment is attempted.

## Coding callback

The authenticated callback reports `awaiting_pr_creation`, `completed` with a PR URL and usage, `blocked` with one concrete question, or `failed` with a bounded summary. Provider token data that is unavailable remains null rather than being inferred.
