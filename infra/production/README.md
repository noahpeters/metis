# Metis production infrastructure

Terraform describes the D1 database, Queues, queue consumer, cron trigger, DNS, Worker route, workers.dev subdomain, and Cloudflare Access policy. Wrangler owns Worker code, encrypted secrets, and bindings so Terraform cannot overwrite a Worker version or secret. Metis does not provision or require a remote Terraform state service.

Pull requests format, validate, and generate a read-only plan. After human merge, `.github/workflows/ci.yml` creates a fresh plan for the exact merge SHA, rejects replacement of persistent resources, applies it under the `production` environment, and only then migrates D1 and deploys both Workers. The repository deployment scripts fail outside GitHub Actions. Do not run `terraform apply` or `wrangler deploy` locally.

Use the repository-local Terraform toolchain only for formatting, validation, and read-only planning:

```sh
./scripts/terraform -chdir=infra/production init
TF_VAR_cloudflare_api_token=... ./scripts/terraform -chdir=infra/production plan
```

Never commit API credentials, Terraform's generated local state, plans, `.tools`, or `.build`. Local applies are not an accepted deployment path.

## Inventory and adoption

Before the first apply, use a read-only Cloudflare token to inventory Workers, versions, encrypted-secret **names**, D1 IDs, queues and consumers, cron triggers, routes, DNS, and Access applications. Save the sanitized inventory in the protected workflow summary; never print secret values. Inspect the generated state only inside the running GitHub Actions job:

```sh
terraform -chdir=infra/production init
terraform -chdir=infra/production state list
```

Import only an address absent from `state list`, using the provider's account/zone-qualified ID from the inventory:

```sh
terraform -chdir=infra/production import cloudflare_d1_database.metis '<account-id>/<d1-id>'
terraform -chdir=infra/production import cloudflare_queue.dispatch '<account-id>/<queue-id>'
terraform -chdir=infra/production import cloudflare_queue.dead_letter '<account-id>/<queue-id>'
terraform -chdir=infra/production import cloudflare_queue_consumer.dispatch '<account-id>/<queue-id>/<consumer-id>'
terraform -chdir=infra/production import cloudflare_workers_cron_trigger.lease_recovery '<account-id>/metis-control-plane/*/10 * * * *'
terraform -chdir=infra/production import cloudflare_workers_script_subdomain.metis '<account-id>/metis-control-plane'
```

Worker scripts and the UI `CONTROL_PLANE` service binding are inventoried and preserved by Wrangler, not adopted into Terraform, because importing a script into Terraform would allow infrastructure apply to replace code, bindings, and encrypted secrets. The DNS record, route, and Access resources are imported in the same way if inventory finds that they already exist. Run `plan -detailed-exitcode`, inspect every change, and require the repository plan guard to pass. A create for an existing object means its import is missing; stop. Any D1, queue, consumer, cron, or subdomain delete/replacement is automatically rejected.

The Access audience is read from the Terraform-created application. `cloudflare_access_team_domain` must be copied from the existing Zero Trust organization settings into the GitHub environment; validation deliberately rejects guesses outside Cloudflare's team-domain form. Terraform outputs both values and the deploy job passes those exact outputs to the UI Worker.

Codex cloud dispatch remains fail-closed until `codex_dispatch_mode` is set to `github_integration`, `codex_github_integration_enabled` is true, the encrypted Worker secret `GITHUB_DISPATCH_USER_TOKEN` is present, the target repository is allowlisted and connected to Codex cloud, and included capacity is enabled in policy and D1. The dispatch token must be a fine-grained GitHub user token restricted to the target repository with Issues read/write; keep it out of Terraform variables and state.

Production accepts the explicitly allowlisted Metis repositories in `production.auto.tfvars`; `metis-sandbox` is an integration target, not a deployment environment. GitHub authentication uses a private GitHub App installation and short-lived installation tokens. Store `GITHUB_APP_PRIVATE_KEY` and `GITHUB_WEBHOOK_SECRET` as encrypted Worker secrets; never put either value in Terraform variables or state.

Before enabling a repository in `METIS_LIFECYCLE_POLICY_JSON`, update the GitHub App to the least privileges required by the lifecycle controller: Issues read/write, Pull requests read/write, Checks read, and Actions read. Subscribe it to Issues, Issue comments, Pull requests, Pull request reviews, Check suites, and Workflow runs. GitHub requires installation owners to approve expanded App permissions. Keep Contents read-only; Metis does not need Git write access.

## In-place cutover runbook

Before any apply, inventory the existing resources and record the current D1 database ID, queue depths, Worker versions,
routes, cron, Access application ID, and encrypted-secret names (never values).

1. Freeze dispatch with the existing provider gate and wait for the dispatch and
   dead-letter queues to drain. Keep webhook ingestion on the old Worker during
   this interval.
2. Import the existing D1 ID at `cloudflare_d1_database.metis` before applying changes. The checked-in Wrangler ID remains
   `fab80b33-f3d1-4fb6-bfa7-05ab613386c5`; verify it before and after the rename.
   Changing the D1 display name must update that object in place. Reject any plan
   that destroys or replaces it.
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
