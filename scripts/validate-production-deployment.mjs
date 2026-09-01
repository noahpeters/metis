const required = [
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_ACCESS_AUDIENCE",
  "CLOUDFLARE_ACCESS_TEAM_DOMAIN",
];

const missing = required.filter((name) => !process.env[name]?.trim());
if (missing.length > 0) {
  console.error(`Production deployment configuration is incomplete: missing ${missing.join(", ")}.`);
  process.exit(1);
}
