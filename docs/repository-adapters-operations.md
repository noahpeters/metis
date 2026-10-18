# Operating repository-backed cloud tasks

## Source stays in Git

Metis never stores a Git repository, packfile, full source tree, or full source
snapshot in D1. A task pins its enrolled repository and immutable commit. The
execution container fetches that commit through a read-only smart-HTTP proxy,
and exports the files into its temporary workspace without exposing its Git
object database or upstream credentials to Codex.

D1 holds task/attempt state, instruction-file hashes, a small Git-reference
metadata descriptor, execution evidence, changed-file blobs, review images,
publication intents and receipts. Unchanged source files are neither uploaded
nor mirrored. Git must retain the pinned commits; D1 is not a repository backup.
Legacy full-source snapshot descriptors are rejected rather than re-created.
Existing rows are not deleted or converted by this release.

## Services and boundaries

1. The control-plane admits a native task and sends its attempt through Queues.
2. The private `metis-codex-runtime` asks `metis-repository-service` for execution
   configuration through a service binding. That configuration contains only
   the selected source, trusted setup/capture instructions and a 30-minute
   task/binding-scoped capability. Provider write credentials and the upstream
   D1 bridge secret never enter the execution container.
3. The public repository-service endpoint validates the capability, then
   forwards only smart Git `info/refs?service=git-upload-pack` and
   `git-upload-pack` requests to the enrolled upstream. It streams pack
   responses and strips client credentials/cookies. Push/receive-pack,
   arbitrary paths, redirects and other query parameters are rejected.
4. Codex runs in the existing subscription-authenticated execution container.
   Metis captures a binary-safe replacement/delete manifest, file modes,
   Markdown and revision-bound before/after UI images. Only changed bytes and
   evidence enter D1. Explicit blocked model outcomes cannot submit a package.
5. The execution supervisor submits the package to the repository service.
   Its separate `RepositoryPublisher` container validates it against the
   durable completed attempt and configured source, checks actual base-file
   hashes and expected review head, applies it to a dedicated change branch,
   and opens/updates the native review. It never invokes Codex and receives no
   subscription credential. Provider credentials are confined to this trusted
   publishing side and the read proxy.
6. Publication intent, operation key, expected previous revision and receipt
   provide idempotency and reconciliation. A failed publication can reuse the
   saved package without another model invocation. Observe/read-change calls
   also go through the publisher and bind to the recorded change identity.

The execution app retains `max_instances: 1`. The publisher is a separate
container app with `max_instances: 1` and a single named Durable Object; it
rejects concurrent requests as busy rather than competing for its slot.
Execution waits while publication completes, so one execution container and
one publisher container can be active together. Both confirm shutdown, with a
forced-stop fallback. This is a new service/app, not an increased execution-app
limit. No R2 resource is provisioned.

No proxy or publisher operation merges a PR, approves/lands an Artifacts diff,
or deploys a project. Existing human approval and automatic release flows
remain authoritative. Existing GitHub issue dispatch is unchanged.

## Enrollment and deployment

Migration 0025 adds `repository_object_grants(binding, ref)`, which scopes
content reads to an enrolled binding. It uses the existing Metis D1 database.
Migration 0024's objects, chunks, records and fenced leases are reused for
change packages; it is no longer a source snapshot store.

The GitHub Actions production workflow applies migrations, deploys the new
repository service/publisher, then deploys the execution runtime, control-plane
and UI. PR checks do not deploy. All Worker configurations preserve existing
secrets. Deploy only through the existing authorized workflow.

Operator enrollment is required; implementation does not copy personal tokens,
broaden GitHub App permissions, rotate existing secrets or install credentials.

On the **control-plane**, retain/install `REPOSITORY_STORE_TOKEN` for its private
D1 bridge. On **metis-repository-service**, install:

- `REPOSITORY_CAPABILITY_KEY`: independently generated high-entropy secret,
  at least 32 characters, used to sign expiring task capabilities.
- `REPOSITORY_PUBLIC_ORIGIN`: its exact HTTPS origin, without a trailing slash,
  path, query or fragment (for example its assigned workers.dev origin).
- `REPOSITORY_PROVIDERS_JSON`: encrypted operator binding configuration below.
- For GitHub App authentication, `GITHUB_APP_ID`,
  `GITHUB_APP_INSTALLATION_ID`, and `GITHUB_APP_PRIVATE_KEY` on this service.
  App enrollment/permission changes require their own authorization. Read Git
  requests mint repository-specific `contents:read` installation tokens;
  publication mints `contents:write`, `pull_requests:write`, `issues:write`.
  The App must already have those permissions and repository access.

The checked-in `REPOSITORY_STORE` service binding routes broker-to-control-plane
store calls privately. It is required; the broker does not fall back to public
Worker-to-Worker fetch. The existing bridge token still authenticates each call.
The trusted Node publisher continues to use the authenticated HTTPS store bridge.

The execution runtime's legacy `REPOSITORY_BINDINGS_JSON` is no longer read.
Remove an old provider-credential binding only through an authorized cleanup;
this change does not delete secrets. Execution uses the checked-in private
`REPOSITORY_SERVICE` binding. Missing enrollment fails admission closed.

Example repository-service secret (placeholders only):

```json
{
  "github-example": {
    "source":{"adapter":"github","repository":"example/project","ref":"main"},
    "remote":"https://github.com/example/project.git",
    "store":{
      "origin":"https://control-plane.example/v1/repositories/store",
      "token":"<matching bridge secret>"
    },
    "taskUiOrigin":"https://metis.example",
    "executionTimeoutMs":90000,
    "requiredChecks":["verify"],
    "requiredDeploymentWorkflows":["CI"]
  },
  "artifacts-example": {
    "source":{"adapter":"artifacts","repository":"namespace/project","ref":"main"},
    "remote":"https://account.artifacts.cloudflare.net/git/namespace/project.git",
    "readAuthorization":"Bearer <short-lived repository read token>",
    "authorization":"Bearer <repository publishing token>",
    "origin":"https://project.example",
    "session":"<authenticated operator review cookie>",
    "store":{
      "origin":"https://control-plane.example/v1/repositories/store",
      "token":"<matching bridge secret>"
    }
  }
}
```

Without App authentication, GitHub bindings may explicitly enroll distinct
`readToken` and `token` credentials. The proxy never falls back to a write token
when its read credential is missing. Do not use a broad personal credential as
an implicit fallback. Artifacts requires the inspected project's Git transport
and authenticated review API; this is not a universal Cloudflare reviews API.
Its repository tokens/operator sessions need renewal by their enrolled owner.
There is no automatic long-lived Artifacts credential refresh in this release.

Interrupted Codex runs remain blocked. Their receipts retain a validated thread
UUID when available, a successful-command count, elapsed time, and the last
command's fixed hint/status/timing. Hints summarize CLI-reported command text;
they do not establish that a required check ran or passed. Raw command text,
stdout, stderr and credentials are excluded. The task API and D1 retain this
metadata for diagnosis; publication still requires a verified completed turn.
Interrupted receipts also retain the latest 32 observed commands with relative
start times and durations, the number of older commands omitted, the last fixed
CLI event type, and time since that event. Overlapping command durations are
tracked independently. This is an observed CLI timeline, not a transcript or
proof that project verification passed. No reasoning text is retained.

`executionTimeoutMs` is opt-in per trusted repository binding: the default stays
90 seconds; integer values are bounded to 1 second through 10 minutes. Existing
five-minute bindings stay at five minutes until explicitly changed. The outer
container request allows at least 10 minutes, or execution plus 3 minutes for
preparation/capture, whichever is longer. The container idle limit exceeds that
request by 2 minutes. The maximum request is 13 minutes, below the existing
20-minute repository lease and 30-minute capability lifetime. Startup and
shutdown have room within the Queue consumer 15-minute wall-clock limit
([Cloudflare limits](https://developers.cloudflare.com/queues/platform/limits/)).
Use one controlled task for this experiment; a batch of long tasks is not a
validated scheduling configuration. These are finite
budgets; unusually long preparation can still exhaust the outer request.

For a controlled diagnostic retry, deploy the exact merged commit first, then
temporarily set only the test binding to `executionTimeoutMs:600000`. Run one
fresh no-op attempt after independently confirming the previous container is
stopped. Compare API and D1 results, command timeline/idle time on interruption,
and provider review output on success. Confirm shutdown independently and remove
temporary provider enrollment afterward. Do not publish incomplete work or
interpret a larger deadline as a demonstrated fix for a stalled Codex turn.

## Change package and limits

The submitted patch is a structured file-change manifest, rather than a
text-only unified diff. Each entry includes a validated relative path, expected
before SHA-256/mode or null, and after SHA-256/mode/content reference or null.
This preserves binaries, additions, deletions and executable modes. The intent
includes repository, exact base commit, task/attempt/change IDs, Markdown, image
pairs, submission digest and, for rework, previous publication/review revision.
The publisher reads referenced changed blobs from D1 and verifies them before
reconstructing a tree. The default branch is never a write target.

Source checkout is independently bounded at 5,000 regular/executable files and
1 GiB of checked-out content. Existing files larger than 5 MiB are supported;
streamed hashing skips them if unchanged. Symlinks/submodules are rejected.
Changed output remains bounded at 5 MiB per added/replaced file, 50 MiB total,
and 1,000 changes. Large unchanged assets do not consume the output budget.
A larger changed file is explicitly blocked; it never causes full-source
storage. Review image comparison limits remain unchanged. Request and metadata
limits can also reject oversized packages before any review write.

The capability-protected store route permits only the attempt's own execution
record/lease, its logical change record, and its publication lineage. It cannot
write change/publication records. Blob reads require a binding-and-repository-specific D1
grant. Grants partition enrolled repositories, not individual attempts within
one repository. Retargeting a binding invalidates existing capabilities and does
not grant access to the previous repository's blobs. The publisher uses the private bridge with fenced leases
for publication records. Raw credentials, capability tokens, source archives,
provider error bodies and model prompts are not logged.

## UI capture, media and rework

Trusted `setupCommands` are bounded argument arrays. An optional capture config
supplies a command, untracked PNG output path, scenario, route and viewport.
The supervisor captures before/after from the actual local interface, validates
PNG bytes and metadata, and binds images to source/change revisions. Example:

```json
{
  "setupCommands":[["npm","ci"]],
  "capture":{
    "command":["node","scripts/capture-review.mjs"],
    "output":"output/review.png",
    "scenario":"Task list with synthetic records",
    "route":"/tasks",
    "viewport":{"width":1280,"height":900,"deviceScaleFactor":1},
    "fullPage":false,
    "label":"Task list",
    "alt":"Task list with synthetic records"
  }
}
```

Configure media transport **on the repository service**, not in execution:
`allowPublicMediaBranch:true` only for explicitly public GitHub repositories
(verified through the provider API); otherwise `media:{origin,token,allowedOrigins}`
for an enrolled gateway. Artifacts can use
`artifactsMedia:{accountId,bucket,apiToken,origin}` for its existing review-media
bucket. No bucket is created. All before/after mappings must validate before
source or review writes. Capture/setup child processes receive no provider,
bridge or publishing credentials.

Task data remains `{ "repositoryBinding":"github-example",
"reviewDescription":"## Change\n\nMarkdown explanation and validation." }`.
The existing UI exposes Run and submit change, publication retry, native review
links, review refresh, and GitHub rework. Rework applies the prior full diff to
the latest target, surfaces text conflicts, rejects unresolved markers, and
conditionally replaces the same change branch/review revision. Human PR-body
edits are preserved; revision summaries are appended idempotently.

**Artifacts rework remains blocked** because its current review update API
lacks an atomic expected-previous-review-version guard. Initial publication and
observation are supported; no unsafe client-only guard is substituted.

## Controlled live validation after authorized rollout

1. Verify CI/deployment for the exact merge, migration 0025, enrolled credentials
   and capability reporting. Confirm existing Worker secrets remain bound.
2. Submit one documentation-only native task against an explicitly disposable
   GitHub repository. Require a single README comment and normal project tests.
3. Independently compare API and D1 task/attempt/execution/publication records.
   Verify D1 contains the tiny Git-reference descriptor and only changed blobs,
   not baseline source. Inspect the native PR's exact files/base/head.
4. Repeat publication/observation against the same execution; confirm no second
   Codex invocation and no duplicate review. Exercise GitHub rework separately.
5. Repeat a documentation-only task against Cabinitron/Artifacts. Verify its
   actual source can resolve despite existing large assets, then inspect the
   source branch and native review. Do not land or approve until authorized.
6. Confirm both containers stopped. Land only the reviewed no-op when authorized,
   then observe exact integration/deployment evidence through the normal release
   pipeline. Local tests and fixture HTTP responses are not live-run proof.

Enrollment and cloud end-to-end checks remain deployment prerequisites. Full
Codex transcript archives, a rich-text editor, approval-rule inference and
Artifacts guarded-update support remain outside this change.

## Live repository execution diagnostics

Repository executions best-effort checkpoint an isolated `progress:<attempt>`
record every five seconds, with at most one write in flight. The existing
execution lease fences writes; capabilities permit writing only that attempt's
progress key, never another task or a publication record. No migration is
needed. Checkpoints never overwrite the execution receipt or change task state.
A failed checkpoint does not fail or replay Codex execution.

The authenticated native task API exposes `observed_progress`, its D1 update
time, and whether the attempt is still running. The existing task page polls
this API and shows running command categories, elapsed time, time since a CLI
event, session identity, and the bounded timeline. Observations older than 15
seconds are marked potentially stale. Terminal result metadata takes precedence;
a retained progress snapshot cannot turn an interrupted run into completion.
This is polling of structured CLI observations, not a raw stdout stream or a
Codex browser session link. Update failures may make observations unavailable.

A trusted provider binding may opt into `captureCommandOutput:true` for a
controlled diagnostic. This retains tails of CLI-reported command output only:
2,000 characters per command and 8,000 across the latest 32 command observations.
Known subscription credential values (including refreshed auth), common
credential-bearing lines and long token-like strings are filtered before
persistence. Provider secrets remain excluded from the CLI environment, and the
repository-store credential guard still applies. The default retains no output.
Private diagnostic tails are untrusted text, rendered as text, and are never
appended to a review description by this feature. Output is available only when
the CLI emits it; a silent child process does not itself generate live output.

### Next Cabinitron no-op experiment

After human merge and exact-commit deployment, temporarily enroll the approved
Cabinitron binding with `executionTimeoutMs:600000` and
`captureCommandOutput:true`. Create a fresh README-comment-only task. Retain the
same five project checks and require this diagnostic harness instead of
launching checks concurrently:

```sh
python3 /app/runtime/container/sequential-checks.py \
  --pnpm /tmp/metis-tools/node_modules/.bin/pnpm --timeout-seconds 240
```

Run from the prepared repository workspace. The harness invokes normal `pnpm
lint`, `typecheck`, `test`, `build`, and `build:worker`, sequentially, without
skipping tests or changing flags. It prints bounded progress every 15 seconds
and saves a private `/tmp/metis-checks-*/progress.json` plus per-check logs.
Verification subprocesses receive `CI=true`, selecting the repository's CI
profile even when the parent environment omits CI or sets it to false. This
leaves the parent Codex environment, repository configuration, and execution
deadlines unchanged. A controlled comparison passed all eight selected geometry
cases under this profile without a GPU; the full cloud suite still needs a
post-deployment rerun. That comparison changed both worker count and test timeout,
so it does not isolate their individual effects.
Have Codex poll this file and print only the current check and its last 20 log
lines (at most 2,000 characters) if its shell command yields a background session.
Do not start another check or another harness while that session is active.
A check that exceeds four minutes or 5 MB of log output is terminated, the
harness stops with a nonzero exit, and the task must report blocked. No later
checks run after failure. This bounds diagnosis; it is not a passing result.

Watch the task page/API and independently SELECT the corresponding progress
record in D1 during execution. Confirm timestamps advance and output is bounded;
compare the terminal API/D1 results and independently confirm the container
stops. Verify native review bytes/check evidence before claiming publication
success. Remove the temporary Cabinitron enrollment and local credential copies,
while preserving GitHub enrollment, Safari login, and the existing gate/token.
