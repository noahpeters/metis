# Metis staging infrastructure

Terraform describes the Cloudflare Worker, D1 database, Queues, queue consumer, cron trigger, bindings, and workers.dev subdomain. State remains local and ignored by Git while the infrastructure backend is being bootstrapped.

Production-like staging deployments happen only through `.github/workflows/ci.yml` after verification succeeds on `main`. The workflow applies D1 migrations and deploys the Worker with the checked-in Wrangler configuration, matching the FTOPS/msgstats release model. The repository deployment scripts fail outside GitHub Actions. Do not run `terraform apply` or `wrangler deploy` locally.

Use the repository-local Terraform toolchain only for formatting, validation, and read-only planning:

```sh
./scripts/terraform -chdir=infra/staging init
TF_VAR_cloudflare_api_token=... ./scripts/terraform -chdir=infra/staging plan
```

Never commit the API token, Terraform state, `.tools`, or `.build`. Any future infrastructure apply workflow must first move Terraform state to a durable remote backend; local applies are not an accepted deployment path.

Codex cloud dispatch remains fail-closed until `codex_dispatch_mode` is set to `github_integration`, `codex_github_integration_enabled` is true, the encrypted Worker secret `GITHUB_DISPATCH_USER_TOKEN` is present, the target repository is allowlisted and connected to Codex cloud, and included capacity is enabled in policy and D1. The dispatch token must be a fine-grained GitHub user token restricted to the target repository with Issues read/write; keep it out of Terraform variables and state.

Staging is intentionally scoped to `noahpeters/metis-sandbox` in `staging.auto.tfvars`. GitHub authentication uses a private GitHub App installation and short-lived installation tokens. Store `GITHUB_APP_PRIVATE_KEY` and `GITHUB_WEBHOOK_SECRET` as encrypted Worker secrets; never put either value in Terraform variables or state.

Before enabling a repository in `METIS_LIFECYCLE_POLICY_JSON`, update the GitHub App to the least privileges required by the lifecycle controller: Issues read/write, Pull requests read/write, Checks read, and Actions read. Subscribe it to Issues, Issue comments, Pull requests, Pull request reviews, Check suites, and Workflow runs. GitHub requires installation owners to approve expanded App permissions. Keep Contents read-only; Metis does not need Git write access.
