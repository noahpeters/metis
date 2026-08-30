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

## Coding callback

The authenticated callback reports `awaiting_pr_creation`, `completed` with a PR URL and usage, `blocked` with one concrete question, or `failed` with a bounded summary. Provider token data that is unavailable remains null rather than being inferred.
