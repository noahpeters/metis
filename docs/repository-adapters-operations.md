# Operating repository-backed cloud tasks

## Implemented path

Native task -> Queue -> private runtime Worker -> configured GitHub/Artifacts
adapter -> pinned source snapshot in D1 -> isolated workspace -> subscription
Codex CLI -> captured replacement changes -> durable publication intent ->
branch/review -> recorded publication result. The model does not create a PR
through the Codex UI. Repository runs require a schema-constrained completed/
blocked outcome; a completed CLI turn alone cannot override a reported blocker
or project instruction requiring human input. Blocked outcomes preserve their
thread and blocker details and cannot publish captured changes. Existing issue-backed dispatch and tasks without a
repository binding keep their previous behavior.

The adapters implement real Git fetch/read/push commands and authenticated
GitHub REST / Cabinitron review-service calls. Tests use local bare Git remotes
and synthetic provider HTTP responses. No live provider publication or cloud
repository task has been verified for this change.

### Current support

| Feature | GitHub | Artifacts/Cabinitron |
|---|---|---|
| Resolve, export source, instruction manifest | Implemented | Implemented through Git source transport |
| Collect text/binary additions, deletions, mode changes | Implemented | Implemented |
| Initial branch and review publication | Implemented | Implemented against the inspected project review API |
| Lost response recovery / immutable publication history | Implemented | Reconcile by branch; ambiguous missing review stays blocked |
| Rework onto a newer base / textual merge conflicts | Implemented | Blocked until the review service supports guarded updates |
| Review/check observation | Exact-revision checks when permissions allow | Exact-revision project CI output; unavailable evidence stays unknown |
| Approval/release evidence | Approval stays unknown; configured deployment workflows must succeed on the exact merge SHA | Project approval, fast-forward integration and per-head release evidence |
| UI before/after images | Explicit public media branch, or configured gateway | Existing project R2 review-media uploader, or configured gateway |

**Artifacts update blocker:** the inspected update API checks the new source
head/base but has no conditional expected-previous-review-version write. The
adapter reports `canUpdate: false` and refuses unsafe updates. A project review
API change is needed before enabling Artifacts rework; no guessed capability
or client-only preflight is treated as an atomic server guard.

## Configuration

Apply migration 0024 through the existing workflow before deploying the
control-plane/runtime/UI. It creates content objects/chunks, publication and
execution records, expiring fenced leases, publication-retry jobs, and a rework
reason on native attempts. No Terraform or Cloudflare resource is added.

Install a new high-entropy `REPOSITORY_STORE_TOKEN` secret on the control-plane.
The `/v1/repositories/store` bridge requires this token on every request. It
has no public object/media route. This secret is independent of the existing
standalone dispatch token, which need not be rotated. Keep actual credentials
out of source, task data, review descriptions, command arguments and logs.

Install `REPOSITORY_BINDINGS_JSON` as a secret on the **runtime Worker**. Keys
are operator-chosen binding IDs, not arbitrary repositories selected by model
output. Example shape (placeholders, never usable credentials):

```json
{
  "example": {
    "source": {"adapter":"github","repository":"example/project","ref":"main"},
    "remote":"https://github.com/example/project.git",
    "token":"<repository-scoped GitHub credential>",
    "authorization":"Basic <base64(x-access-token:credential)>",
    "store": {
      "origin":"https://control-plane.example/v1/repositories/store",
      "token":"<matching REPOSITORY_STORE_TOKEN>"
    },
    "allowPublicMediaBranch":false,
    "executionTimeoutMs":90000
  }
}
```

Git HTTPS credentials are supplied through transient Git configuration headers;
GitHub API credentials through HTTP headers. No credential is written into Git
remotes, source bundles, review intents or model environment. The trusted
container supervisor has the configured credentials; it uses a minimal child
environment for Codex/capture/setup commands. Its known credential values are
checked before source/output bytes or execution/publication records are saved.
This is not a guarantee against arbitrary credential exfiltration by untrusted
code in the same container; only enroll repositories trusted for this execution
boundary. Subscription authentication remains the existing runtime secret;
there is no OpenAI API-key or metered fallback.

GitHub credentials need repository Contents write, Pull requests write and
Issues write (rework summaries are issue comments), plus read access for the
checks/status endpoints if those observations are desired. Set `requiredChecks`
to the expected check/context names to assert a passing validation result, and
`requiredDeploymentWorkflows` to exact workflow names or paths to track release
success on the exact merge SHA. Missing configuration/evidence stays unknown. The existing Metis
App's documented Contents **read-only** permission does not establish that
publication access. Supply a suitably scoped installation/user token; the
adapter does not automatically copy or broaden existing credentials. Token
renewal must be handled by the configured credential owner.

For Artifacts, use `source.adapter: "artifacts"`, the canonical Artifacts Git
remote, `authorization: "Bearer <repository token>"`, review-service `origin`,
and `session` containing its authenticated review cookie. The project must
accept `codex/` source branches and the inspected review protocol. This is not
a universal Cloudflare review API. Expired repository/review sessions block
operations and require credential renewal, without rerunning successful Codex.

## UI capture and media

Enroll a deterministic local screenshot command per project, for example:

```json
{
  "setupCommands":[["npm","ci"]],
  "capture": {
    "command":["node","scripts/capture-review.mjs"],
    "output":"output/review.png",
    "scenario":"Task list with sample records",
    "route":"/tasks",
    "viewport":{"width":1280,"height":900,"deviceScaleFactor":1},
    "fullPage":false,
    "label":"Task list",
    "alt":"Task list with sample records"
  }
}
```

The command must manage its own local application/browser and write the
configured **untracked** PNG path. Project dependency installation is project-specific. The base image includes
Node, Git, Python, ripgrep, Codex, Wrangler and pinned Playwright 1.62.1 Chromium
with Linux dependencies. `PLAYWRIGHT_BROWSERS_PATH` is passed as a non-secret
runtime setting. Use the pinned browser CLI or compatible project Playwright
version; other browser versions need an enrolled compatible image/capture setup. Setup/capture commands are
trusted operator configuration, never task/model-supplied shell strings.
They run as argument arrays with bounded time/output and no repository/store
credentials in the child environment.

The supervisor captures/stores before pixels before launching Codex and after
pixels after collecting its changes. Rework uses a separate clean target-base
workspace for its before capture. The capture file is excluded from source
changes. CRC, PNG structure, dimensions, decompressed row sizes, filter bytes
and declared size are verified. The built-in capture path supports
non-interlaced 8-bit RGB/RGBA single-frame PNG; other encodings need a separately
verified transport. UI changes without paired evidence block publication.

For explicitly public GitHub repositories, `allowPublicMediaBranch: true`
enables an API visibility check, then publishes images to a separate immutable
`codex/metis-media-…` branch with permanent commit-addressed raw URLs. Image
files never enter the source PR. **Do not enable it to expose private media.**
Private repositories need the optional authenticated media gateway instead.
Media branches/objects are retained for review history; this change adds no
cleanup/deletion job.

For the project's existing Artifacts media bucket:

```json
{
  "artifactsMedia": {
    "accountId":"<Cloudflare account ID>",
    "bucket":"existing-project-review-media",
    "apiToken":"<scoped existing-bucket write credential>",
    "origin":"https://project-review.example"
  }
}
```

The uploader uses pinned Wrangler to PUT verified PNGs at `media/<sha256>.png`,
then supplies the native `/api/operator/reviews/media/…` links and the primary
before/after fields. It does **not** provision a bucket. This optional path
requires access to that project's existing R2 bucket; it is not a new R2
requirement for Metis source/result storage or non-UI tasks.

Alternatively configure `media: {origin, token, allowedOrigins}` for an existing
media gateway. It receives an authenticated POST with `key`, base64 `bytes`,
`mimeType`, and `publicationKey`, and returns `{url}`. The gateway must make
same-key retries idempotent and enforce intended reviewer access. Its service
is not provisioned here. Artifacts native media fields require links under
its own review-media origin/path. Missing media transport or unsupported links
block publication rather than silently dropping images.

## Submitting and revisiting work

In the authenticated task UI, set Task data to:

```json
{
  "repositoryBinding":"example",
  "reviewDescription":"## Changes\n\nDescribe the requested result and validation in Markdown."
}
```

Keep original task instructions in the Instructions field. The review body
includes the configured Markdown, the Codex execution report when present, and
the task/attempt identities. Optional binding `taskUiOrigin` adds a reverse link
to the exact Metis execution record. The execution report is model output, not
an assertion that independent project checks passed. Mark ready and choose **Run and submit change**. The control-plane checks runtime binding capabilities before creating an
attempt. Artifacts review descriptions need at least 120 characters. Task data
remains bounded by the task API; it is not a place for tokens or credentials.

Execution completion and publication completion remain separate. The attempt
shows the submitted change URL and publication state. **Retry publication**
creates a new publisher job using the saved execution and intent; it never
launches Codex again. **Refresh review status** performs provider reads against
the recorded revision, keeping unknown/inaccessible evidence unknown.

**Rework change** is available for published GitHub output. Choose issue fixes,
merge-conflict resolution or base refresh and supply the new instructions.
The attempt retains original instructions, adds the rework request, prepares
the prior full diff on the latest target through Git three-way application,
and supplies revision-bound feedback as untrusted context. Unresolved text
markers block collection; binary conflicts require operator resolution.
Publication uses expected-head Git leases, retains the PR, and appends an
idempotent revision summary comment rather than overwriting human PR-body edits.
A failed rework execution retains its rework reason when explicitly retried.

## Recovery and verification

Snapshots and file/image blobs live in `repository_objects` plus chunk rows.
`repository_records` contains `execution:<attempt-id>`,
`publication:<operation-key>`, and `change:<change-id>` records. Publication
intents are persisted before source/review writes. Completed execution records
are reused; running/capturing records with unknown outcomes never authorize a
second Codex run. The task API caps long execution summaries at 4,000 characters;
the full report remains in the private execution record. Source-capture failures retain execution evidence but require
operator follow-up; publication retry cannot reconstruct a deleted workspace.

Publication leases exclude concurrent writers and expire after 20 minutes;
expired owners are fenced from record writes. The repository container request
has a ten-minute deadline, longer than the unchanged proof path, with the same
confirmed shutdown behavior. Credentials, source refs, or required inputs that
cannot be verified leave the operation blocked. Unknown review writes are
reconciled by branch/operation markers and never blindly POSTed again. Missing
review history beyond the Artifacts API's 100-row listing limit is blocked.

Independently SELECT the attempt's standalone receipt, execution/publication
records, and object hashes in D1. Compare the provider review head and body,
publication parent/key, source branch tree and media content. A successful
local test, API receipt, or configured binding is not a production live-run
claim. No merge, approval, deployment, repository deletion, or production-data
mutation is exposed by these adapters.

## Remaining rollout blockers

- Install the bridge/runtime configuration and least-privilege repository and
  review credentials; verify that the cloud container can reach those services.
- Configure local UI setup/capture and appropriate media transport per project.
- Add conditional previous-review-version support in the Artifacts project API
  before enabling its update/rework path.
- Run one authorized cloud GitHub task and one Artifacts task, independently
  verify D1 and native review/media records, then exercise recovery and rework.
- Full Codex transcript retention, rich-text editing/preview, GitHub approval
  rule evaluation and exact deployment evidence remain separate work.
