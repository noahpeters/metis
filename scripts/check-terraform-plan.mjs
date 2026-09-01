import { readFile } from "node:fs/promises";

const plan = JSON.parse(await readFile(process.argv[2], "utf8"));
const protectedTypes = new Set([
  "cloudflare_d1_database",
  "cloudflare_queue",
  "cloudflare_queue_consumer",
  "cloudflare_workers_cron_trigger",
  "cloudflare_workers_script_subdomain",
]);

const unsafe = (plan.resource_changes || []).filter((change) => {
  if (!protectedTypes.has(change.type)) return false;
  const actions = change.change?.actions || [];
  return actions.includes("delete") || (actions.includes("create") && actions.includes("delete"));
});

if (unsafe.length) {
  console.error(`Refusing a destructive production plan: ${unsafe.map((change) => change.address).join(", ")}`);
  process.exit(1);
}

console.log("Production persistence guard passed: no protected resource is deleted or replaced.");
