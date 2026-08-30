# Event model

## GitHub intake

Metis receives native GitHub App webhooks at `POST /webhooks/github`. It accepts only signed `issues.labeled` events whose label is `metis:ready` and repository is allowlisted. `X-GitHub-Delivery` is the idempotency key.

## Internal Queue messages

```json
{ "type": "intake", "taskId": "noahpeters/ftops#123" }
{ "type": "dispatch", "taskId": "noahpeters/ftops#123" }
```

D1 is read on every delivery, so stale payload data cannot override scheduler state.

## Coding callback

The authenticated callback reports `completed` with a PR URL and usage, `blocked` with one concrete question, or `failed` with a bounded summary. Provider token data that is unavailable remains null rather than being inferred.
