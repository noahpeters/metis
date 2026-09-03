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

## Production invariants

There is one control-plane Worker (`metis-control-plane`), one UI Worker
(`metis-ui`), one D1 database (`metis-production`), and one dispatch/dead-letter
queue pair. The checked-in D1 ID is the authoritative database identity and must
never be replaced during deployment.

The control-plane requires the encrypted bindings `GITHUB_APP_PRIVATE_KEY`,
`GITHUB_WEBHOOK_SECRET`, `GITHUB_DISPATCH_USER_TOKEN`, and
`METIS_PROJECT_USER_TOKEN`. Wrangler is configured to retain dashboard-managed
bindings, and the production workflow fails closed when any required binding is
missing. Secret values are never exported, copied through Terraform, or printed.

Every managed repository must appear in both `ALLOWED_REPOSITORIES` and
`METIS_LIFECYCLE_POLICY_JSON`. The checked-in Terraform inputs mirror those
runtime settings so planning cannot report a misleading repository set.

After every exact-merge-SHA deployment, confirm the health endpoint, Access
boundary, current D1 identity, encrypted-binding names, scheduled trigger,
queue bindings, a fresh Project reconciliation, and admission of eligible Ready
issues. A green deployment without a fresh reconciliation is not operational
proof.
