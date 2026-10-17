# D1-only standalone dispatch experiment

This is a deterministic echo proof, not arbitrary Codex execution. Instructions
are data. Task execution uses only Worker HTTP, D1 and Queues; no GitHub client,
GitHub credential, model or R2 binding is required by the standalone path.
The existing GitHub-backed dispatch remains separate and unchanged.

## Infrastructure and schema

The R2 resource from PR #111 is moved out of the production Terraform root to
`infra/optional/standalone-artifacts.tf.example`. Terraform ignores that reference
file. The R2 Worker binding is removed. There is no R2 create/read request in
this experiment, eliminating the bucket-creation path that returned 403 in #111.
This does not establish that every other production permission is sufficient.
Do not enable the optional example for this experiment.

Migration `0021_standalone_d1_proof.sql` only adds columns and new objects:

- `standalone_tasks.result_json`: structured proof, persisted with completed state
  in one fenced UPDATE.
- `execution_started_at`: first claim timestamp, reused on retries.
- `claim_token`: per-attempt lease token, cleared on completion/error.
- `standalone_task_events`: sequence, task_id, state, created_at; insert/state
  triggers capture transitions atomically with the task row.

Existing rows and `artifact_key` remain intact. Historical events are not
backfilled. Old completed R2 tasks can return a null result and their old key.
A healthy new task records `queued -> running -> completed`; result contains
`operation: standalone_proof`, `version: 1`, taskId, exact instructions,
executedAt (UTC ISO timestamp), and `status: completed`. Task created_at and
updated_at plus event timestamps are Unix seconds. Result and completed state
are committed together. Repeat delivery of a terminal task is acknowledged
without changing the result.

A transient executor failure records `running -> queued` and requests retry.
The fourth failed delivery records `failed` and requests retry so Cloudflare
routes it to the existing dead-letter queue (`max_retries: 3`). A consumer crash
leaves a running lease recoverable after 60 seconds; claim tokens fence stale
writers. A live lease requests retry. An unavailable D1 can prevent recording
failure; exhausted deliveries then require operator inspection of D1 and the
DLQ. Queue submission errors return HTTP 503 and an inspectable failed task ID.
Submission and enqueue remain separate operations; ambiguous send outcomes or
process termination between them require operator reconciliation, not automatic
resubmission of a possibly accepted task.

The current workflow migrates D1 before Worker deployment and deploys only on a
push to main. This change does not alter it or add live experiments to CI.
Terraform continues to own only Access configuration. No Worker or encrypted
secret resource is managed by Terraform. Wrangler's existing `keep_vars: true`
is retained; the installed Wrangler upload path sets `keepSecrets: true` and
keeps `secret_text`/`secret_key` bindings. Routine deployment contains no secret
put/delete operation. The installed standalone token is neither read nor rotated.

## Exact live procedure (after separate human approval)

1. Review and human-merge this PR. Allow the existing production workflow to
   validate/apply infrastructure, apply migration 0021, and deploy both Workers.
   Confirm success for the exact merge SHA. Do not run this procedure before
   that deployment is approved and complete.
2. In a secure shell at the repository root, make the known standalone token
   available as `STANDALONE_DISPATCH_TOKEN` without printing it or putting it
   in source or shell history. The existing token's value is unknown; obtaining
   a usable token (or a separately approved rotation) is a live-test blocker.
   Also provide existing D1 read credentials through `CLOUDFLARE_API_TOKEN` and
   `CLOUDFLARE_ACCOUNT_ID`, or an authorized Wrangler login. No R2 permission
   is required. Do not put these in Terraform state or the PR.
3. Run `node scripts/verify-standalone-dispatch.mjs`. Optionally set
   `STANDALONE_BASE_URL` to an explicitly chosen deployed Worker origin.
   The script performs exactly one POST to `/v1/standalone/tasks` with the
   fixed instructions `Metis deterministic standalone D1 proof v1`, saves its
   UUID, and polls authenticated GET `/v1/standalone/tasks/{id}` for two minutes.
4. The script then independently executes remote SELECTs through Wrangler,
   asserting task ID, exact instructions, result fields, timestamps, transitions,
   and equality with the API result. Only exit 0 and `verified: true` establish
   the checked live result. Save its UUID/output and exact deployed version as
   experiment evidence. It does not delete the task.

Manual independent D1 checks, substituting the validated returned UUID:

```sh
npx wrangler d1 execute DB --remote --json --command "SELECT id,instructions,state,result_json,execution_started_at,created_at,updated_at,artifact_key,error FROM standalone_tasks WHERE id='<UUID>'"
npx wrangler d1 execute DB --remote --json --command "SELECT sequence,task_id,state,created_at FROM standalone_task_events WHERE task_id='<UUID>' ORDER BY sequence"
```

Expected: one task row, completed state, non-null matching result_json, null
artifact_key and error, and queued/running/completed events (retry cycles may
occur before completion). API completion alone is insufficient evidence. These
commands are SELECT-only. Do not delete existing tasks, reset queues, or rerun
production migrations manually to perform this check.

## Validation and remaining boundaries

Automated coverage exercises missing/wrong/unconfigured authentication, malformed
input, unknown/invalid IDs, queued persistence, Queue dispatch and processing,
structured result retrieval, duplicate delivery, transient write/claim errors,
lease recovery, submission failure, and retry exhaustion. A Miniflare test runs
the actual HTTP-to-Queue-to-D1 path without GitHub credentials or R2 and queries
D1 separately; an injected D1 trigger forces automatic redelivery through the
configured fourth attempt and dead-letter route. SQLite fault tests additionally
assert deterministic timestamp reuse and terminal result stability.

No production execution is claimed. Local validation is not a deployed-service
result. The production Terraform plan requires Cloudflare credentials unavailable
in this session, and live execution requires an approved deployed version and a
usable standalone token. No production migration, deployment, token rotation or
production-data write was performed during implementation.
