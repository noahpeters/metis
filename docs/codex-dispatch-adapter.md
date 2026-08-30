# Codex dispatch adapter

Metis requires an explicit adapter because generic OpenAI API calls are separately metered and are not assumed to consume ChatGPT/Codex subscription capacity.

Before every launch Metis calls `GET /v1/capabilities`. The adapter must authenticate the request and return:

```json
{
  "provider": "codex",
  "execution": "cloud",
  "billing_mode": "included_subscription",
  "accepting_tasks": true
}
```

Any other billing mode, including `api_metered`, is rejected before task creation. `POST /v1/tasks` receives an idempotency key, repository/issue identity, bounded execution envelope, safety instructions, and callback URL. It returns `{ "id": "...", "status": "queued" }` or `running`.

The adapter must later call Metis with `completed`, `blocked`, or `failed`. Completed work must include a pull-request URL; blocked work must include one concrete question.

## Current availability

The contract and enforcement layer are implemented, but no production driver is checked in. As of the documentation review on 2026-08-30, official OpenAI documentation describes API model execution but does not establish a public endpoint for programmatically creating Codex cloud tasks against included ChatGPT/Codex subscription capacity. Metis therefore remains fail-closed until a supported driver is confirmed.
