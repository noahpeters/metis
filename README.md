# Metis

Metis is a small, budget-aware control plane for AI-assisted software development. GitHub Issues and pull requests remain each repository's engineering system of record; Cloudflare holds only the operational state needed to decide what may run next.

## Architecture

```text
GitHub issue labeled metis:ready
              ↓ signed webhook
Cloudflare Worker ──→ D1 task, lease, capacity, budget, usage state
              ↓
Cloudflare Queue (async dispatch and retry)
              ↓
Workers AI: summarize, size, extract dependencies, classify readiness,
            prioritize, and prepare status summaries
              ↓ admitted by capacity and budget policy
Codex/cloud coding dispatcher: inspect, implement, debug, verify, review
              ↓
Human Create PR checkpoint → GitHub PR, or a first-class BLOCKED state
```

Perplexity is optional and research-only. It is disabled by default. Paid API fallback is also disabled by default and is not part of the coding path.

## What is implemented

- signed and idempotent GitHub webhook ingestion;
- allowlisted target repositories;
- D1 task, dependency, dispatch, lease, provider-capacity, budget-window, and usage records;
- Queue-backed intake, coding dispatch, retry, and expired-lease recovery;
- Workers AI issue analysis for high-volume planning work;
- normalized task size classes and cost units;
- global task, cost, concurrency, retry, and per-task limits;
- hard `metis:budget-blocked` and human-decision `metis:blocked` stops;
- first-class `metis:awaiting-pr` checkpoint that releases the coding lease;
- a provider-neutral callback contract for included-capacity Codex/cloud execution;
- no merge or deployment privileges.

Metis can launch included-capacity Codex cloud work through the supported GitHub integration by posting an idempotent `@codex` task request on an allowlisted issue. `CODEX_DISPATCH_URL` remains available as an authenticated adapter boundary for another supported included-capacity launcher. Metis never silently substitutes a metered OpenAI API call.

See `docs/codex-dispatch-adapter.md` for the authenticated capability, task, idempotency, callback, and fail-closed contract.

## Cloudflare setup

1. Create the staging `metis-staging` D1 database, `metis-dispatch-staging` Queue, and `metis-dead-letter-staging` Queue.
2. Replace the D1 database ID and public Worker URL in `wrangler.jsonc`.
3. Apply `migrations/0001_control_plane.sql`.
4. Set Worker secrets: `GITHUB_WEBHOOK_SECRET`, `GITHUB_TOKEN`, `CODEX_DISPATCH_TOKEN`, and `CODEX_CALLBACK_TOKEN`.
5. Set `CODEX_DISPATCH_URL` to the included-capacity coding dispatcher.
6. Configure a GitHub App webhook to send issue events to `/webhooks/github` and install it only on registered repositories.
7. Deploy only after reviewing provider capacity and budget values.

The Worker updates issue labels/comments. Branch and PR permissions belong to the isolated coding dispatcher.

Current inert staging endpoint: `https://metis-control-plane-staging.gr4gwzrfq2.workers.dev`. Its repository allowlist and Codex capacity remain disabled until a disposable test repository and required secrets are configured.

## Target repository contract

Target repositories stay thin: `.metis.yml` declares verification and guardrails, `AGENTS.md` carries repository-specific instructions, and a shared GitHub App webhook supplies events centrally. There is no per-repository dispatch workflow or token.

## Budgets and capacity

`METIS_POLICY_JSON` controls normalized cost-unit and execution envelopes. The conservative defaults allow two concurrent tasks, four starts and 20 cost units per daily UTC window, two dispatch attempts, automatic small/medium tasks, and approval-required large/unknown tasks.

D1's `provider_capacity` table is the live provider gate. Set `codex_included.available = 0` or reduce `remaining_units` to hard-stop new coding work. Exhausted global or per-task capacity enters `metis:budget-blocked`; Metis does not purchase overflow.

Issue labels can explicitly set `metis:size-small`, `metis:size-medium`, `metis:size-large`, or `metis:size-unknown`; approve an otherwise approval-required envelope with `metis:budget-approved`; and cap a task with a repository-created `metis:max-cost-N` label. The configured size-class ceiling still wins over a larger per-task number.

## Local verification

```sh
npm run verify
```

## Guardrails

- A human applies `metis:ready`.
- Missing information or decisions enter `metis:blocked`, not failure.
- Budget exhaustion stops work before dispatch or retry.
- Metis never merges, deploys, or mutates production data.
- Target CI and human PR review remain authoritative.
