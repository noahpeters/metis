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

## GitHub Codex cloud driver

Metis includes a GitHub-mediated driver for the supported Codex cloud integration. It posts an idempotently marked `@codex` task request to the allowlisted GitHub issue. The request tells Codex to open a pull request, obey repository instructions, never merge or deploy, and return a first-class `BLOCKED:` question when information is missing.

This path does not use the OpenAI API. It relies on the repository being connected to Codex cloud and the GitHub actor being linked to an eligible ChatGPT/Codex account. It is controlled by two independent fail-closed settings:

- `CODEX_DISPATCH_MODE=github_integration`
- `CODEX_GITHUB_INTEGRATION_ENABLED=true`

The repository must also be present in `ALLOWED_REPOSITORIES`, and `codex_included` capacity must be enabled in both policy and D1. Staging keeps all four gates closed by default.

Metis searches existing issue comments for the lease marker before posting, so a queue retry does not launch duplicate Codex work. The existing authenticated callback contract remains available for completion reconciliation; the GitHub driver currently owns launch only.
