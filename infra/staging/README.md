# Metis staging infrastructure

Terraform owns the Cloudflare Worker, D1 database, Queues, queue consumer, cron trigger, bindings, and workers.dev subdomain. State is local and ignored by Git. Wrangler is retained only for local development, bundling, log tailing, and D1 migrations.

Use the repository-local toolchain:

```sh
./scripts/terraform -chdir=infra/staging init
TF_VAR_cloudflare_api_token=... ./scripts/terraform -chdir=infra/staging plan
```

Build `.build/index.js` with Wrangler's dry-run bundler before planning Worker code changes. Never commit the API token, Terraform state, `.tools`, or `.build`.

Codex cloud dispatch remains fail-closed until `codex_dispatch_mode` is set to `github_integration`, `codex_github_integration_enabled` is true, the encrypted Worker secret `GITHUB_DISPATCH_USER_TOKEN` is present, the target repository is allowlisted and connected to Codex cloud, and included capacity is enabled in policy and D1. The dispatch token must be a fine-grained GitHub user token restricted to the target repository with Issues read/write; keep it out of Terraform variables and state.

Staging is intentionally scoped to `noahpeters/metis-sandbox` in `staging.auto.tfvars`. GitHub authentication uses a private GitHub App installation and short-lived installation tokens. Store `GITHUB_APP_PRIVATE_KEY` and `GITHUB_WEBHOOK_SECRET` as encrypted Worker secrets; never put either value in Terraform variables or state.
