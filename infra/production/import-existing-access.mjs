#!/usr/bin/env node

import { spawnSync } from "node:child_process";

const apiToken = process.env.CLOUDFLARE_API_TOKEN || process.env.TF_VAR_cloudflare_api_token;
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID || process.env.TF_VAR_cloudflare_account_id;
const address = "cloudflare_zero_trust_access_application.metis_ui";
const name = "Metis administration";
const domain = "metis.from-trees.com/*";
// The application created by the previous configuration used the bare
// hostname. Import it before Terraform updates it to the current wildcard
// destination, rather than attempting to create a duplicate application.
const discoverableDomains = new Set([domain, "metis.from-trees.com"]);

if (!apiToken || !accountId) {
  console.error("CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID must be set.");
  process.exit(1);
}

if (spawnSync("terraform", ["-chdir=infra/production", "state", "show", address], { stdio: "ignore" }).status === 0) process.exit(0);

const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/access/apps`, {
  headers: { Authorization: `Bearer ${apiToken}` },
});
const payload = await response.json();
if (!response.ok || !payload.success) {
  console.error(`Unable to discover Cloudflare Access applications (${response.status}).`);
  process.exit(1);
}

const matches = payload.result.filter((application) => application.name === name && discoverableDomains.has(application.domain));
if (matches.length > 1) {
  console.error(`Expected at most one ${name} application at ${domain}; found ${matches.length}.`);
  process.exit(1);
}
if (matches.length === 0) process.exit(0);

const imported = spawnSync("terraform", ["-chdir=infra/production", "import", "-input=false", address, `${accountId}/${matches[0].id}`], { stdio: "inherit" });
if (imported.status !== 0) process.exit(imported.status ?? 1);
