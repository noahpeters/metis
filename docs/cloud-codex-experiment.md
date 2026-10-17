# Real Codex execution in Cloudflare Containers

This opt-in experiment extends the D1 proof plumbing with **real Codex CLI
execution in a Cloudflare container**. A local Mac runner is not part of this
design. It uses the owner's ChatGPT subscription, never an OpenAI API key or a
metered fallback. No GitHub issue, comment, workflow, checkout or repository is
involved during task execution. GitHub remains the human-reviewed source and
deployment pipeline for Metis itself.

## Runtime and authentication

Authenticated POST `/v1/standalone/tasks` accepts `executor: "codex"`. Omitting
executor retains the original deterministic proof. Codex admission returns 503
unless the control-plane's `STANDALONE_CODEX_ENABLED` equals `true` and the private
`CODEX_RUNTIME` service binding exists. A `standalone_codex` Queue message invokes
that service over RPC. D1 transitions remain queued -> running -> terminal.
Migration 0022 adds executor (default proof) and optional verification columns;
there are no destructive SQL operations or changes to GitHub-backed dispatch.

`metis-codex-runtime` has workers_dev disabled and its fetch handler always
returns 404. Its RPC method selects a task-specific Container Durable Object.
Wrangler owns the new Worker, Container image and SQLite Durable Object; Terraform
Access infrastructure is untouched. The checked-in capacity is one standard-1
container. The CLI is pinned to 0.163.0 and uses an empty workspace, workspace-write
sandbox, no interactive approvals, ChatGPT-only login, and a 90-second run limit.
There is no automatic relaxation of sandbox settings if Linux sandbox support
fails. Standard Cloudflare compute/storage costs still apply; Codex inference
uses the subscription's entitlements and limits.

A separate subscription credential session lives in the runtime Worker's encrypted
`CODEX_SUBSCRIPTION_AUTH_JSON` secret. It is **not** the standalone HTTP token.
On container startup that secret is supplied only to this isolated runtime. The
server writes a mode-0600 temporary auth.json for Codex, does not load user config,
filters the child environment, and deletes the login/workspace after the run.
The task container can read this credential during the run, as explicitly chosen
by the owner. It receives no Cloudflare, GitHub or control-plane API credentials.
No reusable secret is placed in an image, task message, D1 result or source file.
Known credential values in model output/artifacts are rejected; raw stderr and
prompts are not logged. API-key/non-ChatGPT auth is rejected before CLI launch.

This first experiment imports a **fresh independent auth cache**. CLI token
refreshes are temporary and are not written back to the encrypted Worker secret.
If that session expires, is revoked, or refresh rotation makes the imported cache
stale, execution blocks: provision a fresh separate login. Do not share the same
refresh-token chain with a laptop CLI, clone it across concurrent runtimes, or
claim this snapshot is a permanent credential-renewal service. Durable refresh
ownership is follow-up work before operating this as an unattended scheduler.

## Evidence, retries and failure boundaries

The container launches the actual CLI subprocess, parses its JSONL events, and
requires exit 0, thread ID, completed turn, a successful shell-command event, and
a final message. It captures bounded regular-file artifacts result.json and
solution.mjs with SHA256 hashes. Symlinks and oversized artifacts are excluded.
The result records operation=codex_exec, task ID, included_subscription billing
mode, timestamps and execution evidence. An empty echo/turn without shell work
cannot complete. This establishes an executed Codex turn, not correctness of every
possible arbitrary task.

The acceptance experiment additionally specifies verification=numeric_summary_v1.
Codex must implement a real summarize(values, nonce) function. **After Codex exits**,
a separate Node process inside the container executes its generated solution on
fresh random inputs and an empty-list case unknown to the agent in advance. The
trusted runner compares outputs against its own calculation, including a nonce
SHA256, after removing the temporary auth cache. Wrong/missing code fails. These
verification cases and artifact contents/hashes are stored with the D1 result.
The operator script recalculates both outputs and hashes independently and then
queries remote D1 rather than trusting API state alone.

A task-specific Durable Object persists acceptance before starting a container and
caches terminal receipts. Queue retries retrieve the same receipt; they do not
launch a second Codex job. Concurrent identical RPCs share an in-memory promise.
A process restart after acceptance but before a receipt is durable is ambiguous
and returns blocked. Never automatically replay arbitrary side effects. Main
Worker RPC/result-persistence failures retry the same task ID; after four failed
receipts the D1 task is blocked for inspection and the Queue dead-letters normally.
No normal long execution is held in blockConcurrencyWhile; that lock covers only
the short durable reservation.

Container startup/capacity errors can block a task; this narrow experiment does
not introduce a general-purpose scheduler, resumable repository editing, arbitrary
artifact export, external credential broker or unlimited execution duration.
A missing subscription secret, subscription exhaustion, nonzero CLI exit, sandbox
failure, timeout, missing evidence or failed independent verifier is never success.

## Review, deployment and exact live procedure

1. Review this PR and its container-image CI build. Human merge remains required.
   The existing main-branch workflow applies additive D1 migrations, deploys the
   private runtime **before** the main Worker (which binds it), then deploys the
   UI. It does not set/rotate credentials or launch this experiment. The CI token
   must permit Workers/Containers/registry/Durable Object deployment. A successful
   earlier D1-only deploy does not establish these new permissions. The image is
   built on GitHub's Docker-capable runner. No R2 bucket or binding is introduced.
2. Confirm successful deployment of the exact human merge SHA and container image.
   Check runtime deployment/provisioning and its configured container instance.
3. Create a **separate fresh subscription session**, with operator-approved login:
   use `codex login --device-auth` in a new restricted CODEX_HOME with file-based
   credential storage, and finish the browser/device-code sign-in as the account
   owner. Verify `codex login status` says ChatGPT. Do not copy the existing Mac
   login or send auth.json in chat. Treat it as a password. API-key login is not
   an option. The official auth guide describes headless/device login and cache
   transfer: https://learn.chatgpt.com/docs/auth .
4. Provision the cache into the private runtime using a redirected file, with
   terminal tracing disabled and no credential in argv/history:

   ```sh
   npx wrangler secret put CODEX_SUBSCRIPTION_AUTH_JSON --config wrangler.codex.jsonc < /secure/path/to/separate-codex/auth.json
   ```

   Remove the temporary credential files after confirming provisioning. Do not
   remove the encrypted Worker secret needed for future container startup.
5. Only after authorization for the live run, set the control-plane's
   STANDALONE_CODEX_ENABLED plain-text variable to true through its approved
   configuration surface. It is intentionally absent from checked-in vars, and
   keep_vars preserves a dashboard-managed value. Do not change the existing
   CODEX_DISPATCH_MODE / GitHub integration settings.
6. Supply a usable STANDALONE_DISPATCH_TOKEN securely (separately rotate only if
   authorized), and existing Wrangler D1 read authentication. Run from repo root:

   ```sh
   node scripts/verify-standalone-codex.mjs
   ```

   It submits one real executor task with random numbers/nonce, polls the API,
   checks CLI evidence and both generated artifacts, recalculates the hidden
   verifier's outputs, and performs independent remote D1 SELECTs. Exit 0 and
   verified=true, plus the recorded Worker/container deployment, constitute live
   evidence. Preserve UUID, Codex thread ID, command count and artifact hashes.
7. Independently SELECT standalone_tasks by returned UUID: executor must be codex,
   state completed, result_json.operation codex_exec, turnCompleted true,
   commandCount > 0, billingMode included_subscription, and
   verification.passed true with correct fresh-input outputs. SELECT the event
   ledger ordered by sequence and require queued/running/completed. Leave these
   records in place. Turn STANDALONE_CODEX_ENABLED off after the experiment when
   ongoing execution has not been approved.

## Validation boundary

Local tests stub the Codex event stream and cloud service for repeatable protocol,
failure, auth, deduplication and D1 assertions; they are **not real inference**.
The independent-code verifier tests execute generated JavaScript in a separate
process and reject a fake implementation. Existing real Miniflare HTTP/Queue/D1
proof tests continue to pass, but they do not emulate a Cloudflare container VM.
The pinned CLI's actual help is checked, and CI builds its Linux image without
credentials or inference. No real cloud Codex execution is claimed by these tests.

The implementation machine has no Docker binary/daemon. A runtime dry run can
validate the Worker bundle while excluding container rollout; a real image build
must pass in CI. New Cloudflare deployment permissions and Linux sandbox support
are unverified until those corresponding checks/run succeed. Subscription login,
enablement and a usable task token remain live prerequisites. No production
migration, secret change, enablement, deployment or cloud task is performed by
this implementation task.

Official runtime interfaces:
https://learn.chatgpt.com/docs/non-interactive-mode
https://developers.cloudflare.com/containers/api/container-class/
https://developers.cloudflare.com/containers/get-started/
