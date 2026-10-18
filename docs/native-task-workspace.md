# Native task workspace

Metis owns these tasks independently of GitHub Issues. `/tasks` is an additive,
Cloudflare Access protected workspace alongside the existing operations page.
The GitHub issue scheduler and its task tables keep their existing behavior.

## Available workflow

1. Create a draft with a title, instructions, and a JSON data object.
2. Edit the draft and select prerequisite tasks. Missing/self/cyclic edges are
   rejected transactionally. Optimistic versions prevent stale changes.
3. Mark ready. Instructions, data, and dependencies are then frozen.
4. Explicitly start a cloud execution when prerequisites have completed. Ready
   does not automatically enqueue work; automatic dependency scheduling is a
   follow-up. Unexecuted tasks can be cancelled.
5. Monitor queued/running/completed/blocked/failed states and open the stable
   attempt URL. The page refreshes every five seconds while visible.
6. A failed or blocked attempt can be explicitly retried only when its receipt
   confirms `containerStopped: true`. Each retry gets a new attempt UUID.
   Ordinary completed executions cannot be rerun. A published, updateable GitHub
   change can now start a separate rework attempt through the adapter workflow. Ambiguous shutdown blocks further native
   admissions until operator reconciliation; this release has no override UI.

Task data is not silently injected into the model prompt. A configured
`repositoryBinding` now explicitly selects repository preparation and review
publication; see [repository adapter operations](repository-adapters-operations.md).
Tasks without that field retain the standalone execution behavior.

## Records and execution

Migration 0023 adds `native_tasks`, `native_task_dependencies`, and
`native_task_attempts`. The attempt UUID is also the existing `standalone_tasks`
UUID, the Queue identity, and the runtime's durable deduplication identity.
The task has a stable ID across attempts. Attempt rows retain the requesting
identity and queue-send time. Existing standalone state events and result JSON
remain authoritative; API reads join them instead of copying completion flags.

A D1 transaction checks dependencies, task version, prior attempts, and the
single native execution slot before creating an attempt and standalone row.
It also observes existing queued/running standalone Codex work. Legacy dispatch
and the standalone experiment API remain independent admission paths; this is
not yet a unified capacity scheduler for all Metis work.

Queue messages use `native_codex`, invoking the existing subscription-only
executor, receipt validation, retry, and Durable Object deduplication path.
A committed attempt is an outbox record: initial queue-send failure leaves it
queued. The existing ten-minute cron resends unsent/still-queued attempts with
the same UUID. A crash between send and recording `sent_at` can redeliver safely.
Outbox failures do not abort legacy scheduled reconciliation.

No new Cloudflare infrastructure, R2, secrets, or runtime authentication changes
are required. Apply migration 0023 before deploying the control-plane and UI,
using the existing deployment workflow. The cloud runtime and its subscription
secret must already be configured, and its existing admission setting must be
true for a start request to be accepted.

## Execution tracing

`/tasks/<task-id>/attempts/<attempt-id>` opens the retained Metis execution
record: queue/start/completion timestamps, state events, failure category,
result artifacts/evidence, and the exact Codex thread ID when supplied by the
completed runtime receipt. These reads are authenticated at both UI and RPC.

This is not a Codex cloud browser-session URL. The current CLI uses ephemeral
sessions and deletes its workspace; no full session transcript is archived here.
Failed pre-completion runs may have no thread ID. Durable session retention and
provider navigation remain follow-ups. Never manufacture a Codex URL from a CLI
thread ID.

## Independent verification

Using a read-only D1 query, join `native_task_attempts a` to
`standalone_tasks s ON s.id=a.id`, filtered by `a.task_id`. Inspect `s.state`,
`s.result_json`, and `standalone_task_events WHERE task_id=a.id`. A successful
receipt must include the matching attempt ID, included-subscription billing,
completed turn, successful commands, actual thread ID, and confirmed shutdown.
Task completion is derived from this receipt rather than an editable UI flag.

## Validation and boundaries

Automated SQLite tests cover auth, validation, idempotency, stale writes,
self/missing/cyclic dependencies, dependency order, slot reservation, real queue
handler processing, direct database receipt checks, cross-task UUID collision,
outbox recovery, ambiguous failure, and safe explicit retries. Browser tests
exercise the real local UI -> service RPC -> D1 path at desktop/mobile sizes.
The provider receipt in tests is a fixture; these tests do not run paid or
subscription inference and are not a production end-to-end execution claim.

This slice does not add projects, pagination beyond the latest 200 tasks,
automatic scheduling, running-task cancellation, ambiguous-run reconciliation,
or full session archives. Repository adapter execution is now available through
configured bindings. GitHub and Cloudflare Artifacts /
Cabinitron adapters should each declare context inputs and output publication
contracts, including producing a branch/PR or an artifact review without a
manual provider-UI step.

The shared source, change, publication, and observation contract is defined in [repository adapters](repository-adapters.md). See the linked operating guide for implemented provider paths and rollout blockers.
