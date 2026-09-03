# Add a repository to Metis

Use this runbook whenever Metis begins managing another GitHub repository. A
repository is not ready when it merely appears on the dashboard: every layer
below must agree, and setup is complete only after a real issue launches a
Codex Cloud task.

## Information to collect

- Repository name in `owner/repository` form.
- Default branch name.
- Required deployment workflow names, exactly as GitHub reports them.
- GitHub Project item, Status field, and Execution owner field.
- Codex Cloud environment for the repository.

## Setup checklist

### 1. Prepare the target repository

- [ ] Add an `AGENTS.md` with repository-specific implementation and safety instructions.
- [ ] Add `.metis.yml` with verification commands, protected paths, deployment policy, and repository notes.
- [ ] Confirm the required CI/deployment workflows run on the default branch.
- [ ] Confirm the repository is accessible to the GitHub account whose token is stored as `GITHUB_DISPATCH_USER_TOKEN`.

Metis does not need a per-repository workflow or secret. It comments on issues;
the isolated Codex Cloud task edits the repository.

### 2. Configure the GitHub App

- [ ] Install **Metis Control Plane Noah** on the repository.
- [ ] Grant Issues read/write, Pull requests read/write, Checks read, Actions read, and Contents read-only.
- [ ] Subscribe to Issues, Issue comments, Pull requests, Pull request reviews, Check suites, and Workflow runs.
- [ ] Confirm the webhook URL is `https://metis-control-plane.gr4gwzrfq2.workers.dev/webhooks/github`.
- [ ] Confirm webhook deliveries receive a successful response from that URL.

When App permissions or repository access expand, the installation owner may
need to approve the change. The App credential handles control-plane actions;
it is not the identity that triggers Codex.

### 3. Configure user-authored Codex dispatch

- [ ] Give the fine-grained token stored as `GITHUB_DISPATCH_USER_TOKEN` access to the repository with Issues read/write.
- [ ] Keep `CODEX_DISPATCH_MODE=github_integration` and `CODEX_GITHUB_INTEGRATION_ENABLED=true`.
- [ ] Confirm the GitHub user is connected to the correct ChatGPT/Codex workspace.
- [ ] Create a Codex Cloud environment whose Repository is the exact target repository and share it with the intended workspace.
- [ ] From the Codex environment page, confirm the repository name and that a task can be started.

The token must remain an encrypted secret on `metis-control-plane`; never add it
to source, Terraform, GitHub variables, logs, or the UI Worker.

### 4. Add the repository to production configuration

- [ ] Add `owner/repository` to `ALLOWED_REPOSITORIES` in `wrangler.jsonc`.
- [ ] Add it to `METIS_LIFECYCLE_POLICY_JSON` with exact required deployment workflow names.
- [ ] Add the same repository and lifecycle settings to `infra/production/production.auto.tfvars` so Terraform validation and runtime configuration cannot drift.
- [ ] Update tests and documentation whose expected allowlist is explicit.
- [ ] Run `npm run verify` and the relevant full-stack tests.
- [ ] Merge or push the change to `main` through the authorized workflow and wait for the exact-SHA `CI` deployment to finish successfully.

Do not deploy locally. A normal production deployment must retain all four
encrypted control-plane secrets:

- `GITHUB_APP_PRIVATE_KEY`
- `GITHUB_DISPATCH_USER_TOKEN`
- `GITHUB_WEBHOOK_SECRET`
- `METIS_PROJECT_USER_TOKEN`

### 5. Add work to Metis Main Project

- [ ] Add the issue to Metis Main Project.
- [ ] Set **Execution owner** to **Metis**.
- [ ] Set **Status** to **Ready**.
- [ ] Add the appropriate `metis:size-*` label.
- [ ] Add `metis:budget-approved` when the selected size or policy requires it.
- [ ] Use GitHub's structured `blocked by` relationships for real dependencies; do not encode dependencies only in prose.

Project Status=Ready is the human authorization signal. Lifecycle labels show
Metis state but do not admit work. Moving an ordinary blocked Project item back
to Ready explicitly requests one retry; budget and recovery blocks retain their
dedicated safeguards.

### 6. Prove the integration end to end

- [ ] Run **Nudge** or wait for the ten-minute scheduler.
- [ ] Confirm a fresh Project reconciliation succeeds and observes the issue.
- [ ] Confirm the task moves through `intake`, `ready`/`retrying`, `dispatching`, and `pending_connector_ack`.
- [ ] Confirm the issue receives a user-authored, lease-marked `@codex` comment.
- [ ] Confirm Codex Cloud shows a **GitHub Mention** task for the exact repository and issue.
- [ ] Confirm the task is actually running; a dashboard repository card alone is not proof.
- [ ] When Codex finishes, confirm its official comment contains the task link and `READY_FOR_PR:`, Metis releases the lease, and the issue moves to the awaiting-PR state.

## Fast troubleshooting

Work from the first failed boundary instead of rotating every credential.

| Symptom | Check first | Likely cause |
| --- | --- | --- |
| Repository is absent from the dashboard | Wrangler and Terraform allowlists and lifecycle policies | Configuration drift or deployment not completed |
| Repository appears but shows 0 Ready issues | Project Status, Execution owner, and latest Project reconciliation | Item is not exactly Ready/Metis, Project credential cannot see it, or schema IDs drifted |
| Nudge changes nothing | Latest `project_reconciliation_runs` failure and `METIS_PROJECT_USER_TOKEN` binding | Missing/incorrect Project token, pagination/schema failure, or stale UI observation |
| Ready immediately becomes Blocked | Task blocker and latest connector/control-plane comment | Prior provider rejection was reconciled, or protected budget/recovery state still applies |
| No `@codex` comment appears | Dispatch user token repository access and Issues write permission | `GITHUB_DISPATCH_USER_TOKEN` cannot comment on the repository |
| `@codex` comment appears but Codex requests an environment | Codex environment Repository and workspace sharing | Environment is missing or attached to another repository/workspace |
| `@codex` comment appears but Metis sees no connector reply | GitHub App webhook URL and Recent Deliveries response | Webhook targets an obsolete Worker or delivery failed |
| Codex task is running while Metis says pending acknowledgment | Codex task list and issue comments | Normal until the official connector posts a stable task/completion link |
| PR opens but Metis does not bind it | Exact `Metis-Task: owner/repository#issue` PR-body marker and webhook delivery | Missing marker, wrong identity, or Pull request webhook problem |
| Merge never completes in Metis | Exact merge SHA and every configured workflow name | Workflow-name mismatch or deployment did not succeed on the merge SHA |

## Production invariants to verify

- One `metis-control-plane` Worker and one `metis-ui` Worker.
- GitHub App webhook points only to the production control-plane URL.
- One D1 database named `metis-production`, matching the checked-in UUID.
- One `metis-dispatch` queue and one `metis-dead-letter` queue.
- Exactly the four required encrypted secret bindings exist on the control-plane Worker; secret values are never printed.
- The ten-minute scheduled trigger is present.
- The UI `CONTROL_PLANE` service binding points to `metis-control-plane`.
- No repository-specific staging Worker, database, queue, webhook, environment, or configuration branch is introduced.

After setup, record the successful deployment run, reconciliation timestamp,
dispatch comment, and Codex task link. Those four artifacts make later diagnosis
much faster and distinguish configuration, scheduling, dispatch, and connector
failures.
