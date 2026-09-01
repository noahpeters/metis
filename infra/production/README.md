# Metis production infrastructure

Terraform describes the Cloudflare Access application and its verified-domain policy. Wrangler owns the Worker code, custom domain, D1/Queue bindings, encrypted secrets, and runtime triggers, matching the FTOPS split between Terraform Access configuration and Wrangler deployments. Metis does not provision or require a remote Terraform state service.

Pull requests format, validate, and generate a read-only plan. After human merge, `.github/workflows/ci.yml` creates a fresh plan for the exact merge SHA, rejects replacement of persistent resources, applies it under the `production` environment, and only then migrates D1 and deploys both Workers. The repository deployment scripts fail outside GitHub Actions. Do not run `terraform apply` or `wrangler deploy` locally.

Use the repository-local Terraform toolchain only for formatting, validation, and read-only planning:

```sh
./scripts/terraform -chdir=infra/production init
TF_VAR_cloudflare_api_token=... ./scripts/terraform -chdir=infra/production plan
```

Never commit API credentials, Terraform's generated local state, plans, `.tools`, or `.build`. Local applies are not an accepted deployment path.

## Existing application discovery

Like FTOPS, every CI run checks Cloudflare for an existing Access application with the exact configured name and domain and imports that application into the transient Terraform run before planning. No match means the first apply will create it; multiple matches fail closed. The script never reads or prints credentials.

Worker scripts and the UI `CONTROL_PLANE` service binding remain outside Terraform so infrastructure apply cannot replace code, bindings, queues, D1 data, or encrypted secrets.

The UI hostname is checked into `wrangler.ui.jsonc` as a Worker custom domain, matching the FTOPS deployment pattern and avoiding a separate zone-ID setting. Cloudflare Access injects the authenticated identity header after enforcing the checked-in `from-trees.com` policy; the UI rejects missing or out-of-domain identities.

Codex cloud dispatch remains fail-closed until `codex_dispatch_mode` is set to `github_integration`, `codex_github_integration_enabled` is true, the encrypted Worker secret `GITHUB_DISPATCH_USER_TOKEN` is present, the target repository is allowlisted and connected to Codex cloud, and included capacity is enabled in policy and D1. The dispatch token must be a fine-grained GitHub user token restricted to the target repository with Issues read/write; keep it out of Terraform variables and state.

Production accepts the explicitly allowlisted Metis repositories in `production.auto.tfvars`; `metis-sandbox` is an integration target, not a deployment environment. GitHub authentication uses a private GitHub App installation and short-lived installation tokens. Store `GITHUB_APP_PRIVATE_KEY` and `GITHUB_WEBHOOK_SECRET` as encrypted Worker secrets; never put either value in Terraform variables or state.

Before enabling a repository in `METIS_LIFECYCLE_POLICY_JSON`, update the GitHub App to the least privileges required by the lifecycle controller: Issues read/write, Pull requests read/write, Checks read, and Actions read. Subscribe it to Issues, Issue comments, Pull requests, Pull request reviews, Check suites, and Workflow runs. GitHub requires installation owners to approve expanded App permissions. Keep Contents read-only; Metis does not need Git write access.

## In-place cutover runbook

Before any cutover, record the current D1 database ID, queue depths, Worker versions,
routes, cron, Access application ID, and encrypted-secret names (never values).

1. Freeze dispatch with the existing provider gate and wait for the dispatch and
   dead-letter queues to drain. Keep webhook ingestion on the old Worker during
   this interval.
2. The checked-in Wrangler D1 ID remains `fab80b33-f3d1-4fb6-bfa7-05ab613386c5`; verify it before and after deployment. Terraform does not manage or replace it.
3. Queues cannot be renamed in place. Only after both queues are empty, create
   `metis-dispatch` and `metis-dead-letter`, then merge the configuration change
   so GitHub Actions atomically deploys the new producer/consumer bindings. Keep
   the old empty queues through the rollback window.
4. Rename the existing control-plane Worker with the Cloudflare API or import
   its new identity, preserving its deployed version and encrypted bindings.
   Provision the UI DNS record, route, Access application/policy, and GitHub
   `production` environment variables. Copy each encrypted binding directly
   between Workers through Cloudflare's secret interface; never export its value
   to Terraform, Git, or logs. Required control-plane secrets are
   `GITHUB_APP_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET`,
   `GITHUB_DISPATCH_USER_TOKEN`, `METIS_PROJECT_USER_TOKEN`, and
   `UI_BINDING_TOKEN`; the UI uses the same `UI_BINDING_TOKEN`.
5. Merge only after the production environment is configured. The `CI` workflow
   migrates the preserved D1 first, deploys `metis-control-plane`, and then
   deploys `metis-ui` with its private service binding. Switch the GitHub webhook
   URL once, after the new control-plane health check succeeds; retain the same
   webhook secret and disable the old trigger immediately to prevent duplicates.
6. Unfreeze dispatch only after exact-merge-SHA workflow success. Confirm the D1
   task/lease/dependency/provider-observation/usage row counts and newest records,
   scheduler cron, a signed webhook delivery (including redelivery idempotency),
   queue production/consumption, and a Codex dispatch. Authenticate at
   `https://metis.from-trees.com` with a verified `from-trees.com` identity,
   confirm the UI reaches the control plane, and attach a browser screenshot to
   the implementation PR.

Rollback re-enables the recorded old Worker version, bindings, queues, route, and
webhook URL while dispatch remains frozen. It never restores D1 from a blank
copy: the preserved database ID is authoritative. Reconcile webhook delivery IDs
before unfreezing. Delete old empty queues and obsolete Worker names only after
the observation window and all exact-SHA checks pass.
