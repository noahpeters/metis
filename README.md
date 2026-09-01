# Metis

Metis is a small, pacing-aware control plane for AI-assisted software development. GitHub Issues and pull requests remain each repository's engineering system of record; Cloudflare holds only the operational state needed to decide what may run next.

## Architecture

```text
GitHub issue in Metis Main Project (Execution owner=Metis, Status=Ready)
              ↓ ordered reconciliation
Cloudflare Worker ──→ D1 task, lease, capacity-gate, pacing, and event state
              ↓
Cloudflare Queue (async dispatch and retry)
              ↓
Workers AI: summarize, size, extract dependencies, classify readiness,
            prioritize, and prepare status summaries
              ↓ admitted by capacity-gate and pacing policy
Codex/cloud coding dispatcher: inspect, implement, debug, verify, review
              ↓
Human Create PR checkpoint → GitHub PR, or a first-class BLOCKED state
```

Perplexity is optional and research-only. It is disabled by default. Paid API fallback is also disabled by default and is not part of the coding path.

## What is implemented

- signed and idempotent GitHub lifecycle webhook ingestion;
- Project-only, position-ordered normal admission with durable reconciliation audit records;
- allowlisted target repositories;
- D1 task, dependency, dispatch, lease, provider-capacity-gate, pacing-window, and event records;
- Queue-backed intake, coding dispatch, retry, and expired-lease recovery;
- Workers AI issue analysis for high-volume planning work;
- task size classes and legacy estimated workload units;
- global task-start, estimated-workload, concurrency, retry, and per-task limits;
- task-specific `metis:budget-blocked`, evidence-backed `metis:blocked`, and scheduler-level capacity deferrals;
- first-class `metis:awaiting-pr` checkpoint that releases the coding lease;
- explicit human-only merge readiness with exact-SHA post-merge monitoring;
- exact-merge-SHA deployment monitoring and repository health locks;
- bounded, idempotent corrective-PR recovery that outranks normal work;
- a provider-neutral callback contract for included-capacity Codex/cloud execution;
- no direct default-branch push, forced merge, or manual deployment path.

Metis can launch included-capacity Codex cloud work through the supported GitHub integration by posting an idempotent `@codex` task request on an allowlisted issue. `CODEX_DISPATCH_URL` remains available as an authenticated adapter boundary for another supported included-capacity launcher. Metis never silently substitutes a metered OpenAI API call.

See `docs/codex-dispatch-adapter.md` for the authenticated capability, task, idempotency, callback, and fail-closed contract.

## Deployment

Metis deploys only from GitHub Actions after verification succeeds on `main`. The workflow applies D1 migrations and deploys the Worker using `wrangler.jsonc`. Configure the repository's `production` environment with `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`; keep GitHub App, Project, and dispatch credentials as encrypted Worker secrets. Provision or rotate Worker secrets separately from routine deployment so an unchanged deploy never rewrites credentials or creates an extra Worker version.

Harmless documentation-only commits may be used to exercise the managed pull-request and deployment lifecycle.

Local `wrangler deploy`, D1 migration, and `terraform apply` operations are not accepted deployment paths. The repository deployment scripts enforce the GitHub Actions boundary. Terraform remains the infrastructure definition and may be formatted, validated, or planned locally without applying changes.

### Administration UI operator setup

The administration shell runs as the dedicated `metis-ui` Worker and reaches the control plane only through its `CONTROL_PLANE` service binding. Before the first GitHub-Actions deployment, the operator must:

1. configure a Cloudflare Access identity provider that returns verified email claims;
2. protect the fixed `metis.from-trees.com` hostname with Cloudflare Access and allow verified `from-trees.com` identities; and
3. deploy the checked-in `CONTROL_PLANE` RPC service binding. The binding itself is the private capability, so no duplicated cross-Worker secret or inferred HTTP header is required.

Access permits only verified `from-trees.com` identities. The UI verifies the signed Access JWT rather than trusting the convenience email header. Local authentication requires both `ENVIRONMENT=local` and `LOCAL_AUTH_ENABLED=true`; deployed configuration fixes the latter to `false`.

The Worker updates issue labels/comments. Branch and PR permissions belong to the isolated coding dispatcher.

Production control-plane endpoint: `https://metis-control-plane.gr4gwzrfq2.workers.dev`. The protected administration UI is `https://metis.from-trees.com`. The allowlist contains Metis and the disposable `noahpeters/metis-sandbox` integration target; included Codex capacity is enabled while paid API and Perplexity fallback remain disabled.

## Target repository contract

Target repositories stay thin: `.metis.yml` declares verification and guardrails, `AGENTS.md` carries repository-specific instructions, and a shared GitHub App webhook supplies events centrally. There is no per-repository dispatch workflow or token.

Metis is itself an allowlisted target. Its `.metis.yml` requires explicit budget approval, treats workflows, Terraform, and migrations as protected paths, forbids coding-task deployment, and delegates production deployment exclusively to the `CI` workflow after a human merge. `metis-sandbox` remains the disposable integration target.

## Pacing and provider capacity

`METIS_POLICY_JSON` controls operator pacing and execution envelopes. The conservative defaults allow two concurrent tasks, four starts and 20 estimated workload units per daily UTC window, two dispatch attempts, automatic small/medium tasks, and approval-required large/unknown tasks. `maxTasksPerWindow` is optional operator pacing, not evidence about a provider account.

D1's `provider_capacity.available` flag is an explicit operator gate. Set `codex_included.available = 0` to stop new coding work. Metis treats actual provider capacity as unknown unless the provider reports it; local workload estimates never establish or consume provider capacity. A closed gate or exhausted pacing window leaves tasks Ready and records one scheduler-level deferral signal; it never creates a task attempt, lease, blocker label, or human question. Task-specific approval and workload ceilings remain enforced, and paid API or purchased-credit fallback stays disabled.

Issue labels can explicitly set `metis:size-small`, `metis:size-medium`, `metis:size-large`, or `metis:size-unknown`; approve an otherwise approval-required envelope with `metis:budget-approved`; and cap a task with the legacy `metis:max-cost-N` label. Existing policy keys, labels, and migrated records using “cost units” remain readable only as legacy estimated workload—not provider accounting. The configured size-class ceiling still wins over a larger per-task number.

Provider reporting is intentionally separate from local pacing. The supported-signal, privacy, and ledger boundary is documented in [`docs/chatgpt-codex-analytics-audit.md`](docs/chatgpt-codex-analytics-audit.md).

## Local verification

```sh
npm run verify
```

The production-shaped browser suite runs separately so unit verification stays
fast. Install Chromium once with `npx playwright install chromium`, then run:

```sh
npm run test:full-stack
```

The suite starts the actual control-plane and UI entrypoints in one multi-Worker
Miniflare runtime, migrates an isolated local D1 database, and connects the
Workers with the real `CONTROL_PLANE` RPC service binding. Chromium covers local
authentication, rendered pacing states, and a reset initiated through the UI;
the test then verifies the new window and audit row directly in local D1. It
configures no remote Worker or database. Failure evidence is saved under
`output/full-stack/` for CI artifact upload.

## Guardrails

- Only an open, allowlisted issue in Metis Main Project with `Execution owner=Metis` and `Status=Ready` can enter normal intake. Labels are lifecycle visibility only and never authorize admission.
- Project credential, schema, pagination, or availability failures are recorded and pause new admission; active D1 tasks and exact-SHA merge/deployment monitoring continue.
- Missing information or decisions enter `metis:blocked`, not failure.
- Pacing exhaustion defers work before dispatch or retry without changing its Ready state.
- Metis never pushes directly to a default branch, forces a merge, manually deploys, or mutates production data.
- Pull-request merges are human-only. Metis never enables auto-merge or calls a merge endpoint; it observes the signed merged webhook and monitors the exact merge SHA through deployment.
- A merge is incomplete until every configured deployment workflow succeeds for the exact merge SHA.
- Deployment failure freezes normal dispatch and starts a bounded corrective-PR recovery chain.
- Target CI and human PR review remain authoritative.
