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

Metis includes a GitHub-mediated driver for the supported Codex cloud integration. It posts an idempotently marked, user-authored `@codex` task request to the allowlisted GitHub issue. Posting leaves the dispatch in `pending_connector_ack`; only an official connector response containing a stable Codex task link advances it to `running`. The request tells Codex to open a pull request, obey repository instructions, never merge or deploy, and return a first-class `BLOCKED:` question when information is missing.

Official connector acknowledgments also create an idempotent capacity observation tied to the dispatch and connector comment. A stable task link is `accepted` evidence; an explicit provider limit is `exhausted`; environment, permission, configuration, and integration failures are `unavailable`; an otherwise explicit refusal is `rejected`; and an ambiguous acknowledgment remains `unknown` without advancing the dispatch or creating another task. Only accepted and exhausted evidence changes the provider gate. Reset time and limit reason are retained only when the connector supplies them, and dispatch acceptance never implies token or credit usage.

An exhausted gate is automatically reenergized on the first scheduled reconciliation at or after the supplied reset time. When the connector supplies no reset time, Metis uses a bounded 60-minute retry interval. Automatic and authenticated operator-initiated reenergizations are idempotently audited, reopen only an exhausted gate, and immediately reconsider Ready work; if capacity is still exhausted, the next provider response closes the gate again.

Official setup/environment-required and generic pre-creation rejection responses block the task even when they do not use `BLOCKED:`. Metis records the response and correlation result, releases the lease and demonstrably unused operational reservations, and preserves any setup link in the blocker. Ambiguous or missing acknowledgments require reconciliation and are never treated as safe refunds. Reapplying the human `metis:ready` decision creates one new lease; comment markers make delivery idempotent within each attempt.

This path does not use the OpenAI API. It relies on the repository being connected to Codex cloud and the GitHub user being linked to an eligible ChatGPT/Codex account. GitHub App installation-token comments are intentionally not used for dispatch because they are bot-authored and do not trigger Codex. The App remains responsible for webhook and control-plane operations.

Dispatch requires a narrowly scoped fine-grained GitHub personal access token stored only as the encrypted Worker secret `GITHUB_DISPATCH_USER_TOKEN`. Restrict it to the target repository and grant Issues read/write; do not place it in Terraform variables or state. It is controlled by three independent fail-closed settings:

- `CODEX_DISPATCH_MODE=github_integration`
- `CODEX_GITHUB_INTEGRATION_ENABLED=true`
- `GITHUB_DISPATCH_USER_TOKEN` is present

The repository must also be present in `ALLOWED_REPOSITORIES`, and `codex_included` capacity must be enabled in both policy and D1. Missing credentials or capacity keep dispatch closed.

Metis includes the explicit HTTPS repository remote, `main` base branch, and `Metis-Task` PR-body marker in every launch, then searches existing issue comments for the lease marker before posting so a queue retry does not launch duplicate Codex work. The task is instructed to commit and prepare PR metadata without trying to push or use `gh`. A `READY_FOR_PR:` comment authored by the official `chatgpt-codex-connector` releases the lease, moves the issue to `metis:awaiting-pr`, and links the human to Codex Cloud's **Create PR** handoff. When that marked handoff PR opens, Metis binds it directly without changing its ownership. Unmarked, cross-repository, non-awaiting, and unrelated PRs are never claimed. An official `BLOCKED:` comment releases the lease and moves the issue to `metis:blocked`. The existing authenticated callback contract remains available for other completion reconciliation. Pull-request merges remain human-only.
