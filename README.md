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
- guarded GitHub-native auto-merge with repository-specific opt-in;
- exact-merge-SHA deployment monitoring and repository health locks;
- bounded, idempotent corrective-PR recovery that outranks normal work;
- a provider-neutral callback contract for included-capacity Codex/cloud execution;
- no direct default-branch push, forced merge, or manual deployment path.

Metis can launch included-capacity Codex cloud work through the supported GitHub integration by posting an idempotent `@codex` task request on an allowlisted issue. `CODEX_DISPATCH_URL` remains available as an authenticated adapter boundary for another supported included-capacity launcher. Metis never silently substitutes a metered OpenAI API call.

See `docs/codex-dispatch-adapter.md` for the authenticated capability, task, idempotency, callback, and fail-closed contract.

## Deployment

Metis deploys only from GitHub Actions after verification succeeds on `main`. The workflow applies D1 migrations and deploys the Worker using `wrangler.jsonc`. Configure the repository's `staging` environment with `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`; keep GitHub App and dispatch credentials as encrypted Worker secrets.

Local `wrangler deploy`, D1 migration, and `terraform apply` operations are not accepted deployment paths. The repository deployment scripts enforce the GitHub Actions boundary. Terraform remains the infrastructure definition and may be formatted, validated, or planned locally without applying changes.

The Worker updates issue labels/comments. Branch and PR permissions belong to the isolated coding dispatcher.

Current staging endpoint: `https://metis-control-plane-staging.gr4gwzrfq2.workers.dev`. It is restricted to the disposable `noahpeters/metis-sandbox` repository and included Codex capacity; paid API and Perplexity fallback remain disabled.

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
- Metis never pushes directly to a default branch, forces a merge, manually deploys, or mutates production data.
- Metis may enable GitHub-native auto-merge after explicit repository gates pass; it never calls a forced/direct merge path.
- A merge is incomplete until every configured deployment workflow succeeds for the exact merge SHA.
- Deployment failure freezes normal dispatch and starts a bounded corrective-PR recovery chain.
- Target CI and human PR review remain authoritative.
