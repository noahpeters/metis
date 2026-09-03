import { writeFile, readFile } from "node:fs/promises";

const mode = process.argv[2];
if (!process.env.GITHUB_ACTIONS || !["prepare", "finalize"].includes(mode)) {
  throw new Error("Production cutover may run only in GitHub Actions as prepare or finalize.");
}

const accountId = requireEnv("CLOUDFLARE_ACCOUNT_ID");
const apiToken = requireEnv("CLOUDFLARE_API_TOKEN");
const apiRoot = `https://api.cloudflare.com/client/v4/accounts/${accountId}`;
const productionWorker = "metis-control-plane";
const credentialWorker = `${productionWorker}-staging`;
const replacedWorker = `${productionWorker}-replaced`;
const databaseId = "fab80b33-f3d1-4fb6-bfa7-05ab613386c5";
const databaseName = "metis-production";
const requiredSecrets = [
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_DISPATCH_USER_TOKEN",
  "GITHUB_WEBHOOK_SECRET",
  "METIS_PROJECT_USER_TOKEN",
].sort();
const statePath = "/tmp/metis-production-cutover.json";

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

async function cf(path, options = {}) {
  const response = await fetch(`${apiRoot}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });
  const payload = await response.json();
  if (!response.ok || payload.success === false) {
    const message = payload.errors?.map((error) => error.message).join("; ") || response.statusText;
    throw new Error(`Cloudflare ${options.method || "GET"} ${path} failed: ${message}`);
  }
  return payload.result;
}

async function workers() {
  return cf("/workers/workers?per_page=100");
}

async function findWorker(name) {
  return (await workers()).find((worker) => worker.name === name);
}

async function renameWorker(worker, name) {
  return cf(`/workers/workers/${worker.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/merge-patch+json" },
    body: JSON.stringify({ name }),
  });
}

async function secretNames(name) {
  try {
    const secrets = await cf(`/workers/scripts/${name}/secrets`);
    return secrets.map((secret) => secret.name).sort();
  } catch (error) {
    if (String(error).includes("not found")) return [];
    throw error;
  }
}

function requireSecrets(actual, workerName) {
  const missing = requiredSecrets.filter((name) => !actual.includes(name));
  if (missing.length) throw new Error(`${workerName} is missing required secrets: ${missing.join(", ")}`);
}

async function prepare() {
  const startedAt = Math.floor(Date.now() / 1000);
  const production = await findWorker(productionWorker);
  const credentialSource = await findWorker(credentialWorker);
  if (!production) throw new Error(`${productionWorker} does not exist.`);

  const productionSecrets = await secretNames(productionWorker);
  if (!credentialSource) {
    requireSecrets(productionSecrets, productionWorker);
    await writeFile(statePath, JSON.stringify({ promoted: false, startedAt }));
  } else {
    requireSecrets(await secretNames(credentialWorker), credentialWorker);
    if (await findWorker(replacedWorker)) throw new Error(`${replacedWorker} already exists; refusing an ambiguous cutover.`);
    await renameWorker(production, replacedWorker);
    try {
      await renameWorker(credentialSource, productionWorker);
    } catch (error) {
      await renameWorker(production, productionWorker);
      throw error;
    }
    requireSecrets(await secretNames(productionWorker), productionWorker);
    await writeFile(statePath, JSON.stringify({ promoted: true, replacedWorkerId: production.id, startedAt }));
  }

  const database = await cf(`/d1/database/${databaseId}`);
  if (database.name !== databaseName) {
    const renamed = await cf(`/d1/database/${databaseId}`, {
      method: "PATCH",
      body: JSON.stringify({ name: databaseName }),
    });
    if (renamed.name !== databaseName || renamed.uuid !== databaseId) {
      throw new Error("D1 rename did not preserve the authoritative database identity.");
    }
  }
}

async function finalize() {
  requireSecrets(await secretNames(productionWorker), productionWorker);
  const database = await cf(`/d1/database/${databaseId}`);
  if (database.name !== databaseName || database.uuid !== databaseId) {
    throw new Error("Production D1 identity or name is incorrect after deployment.");
  }

  const state = JSON.parse(await readFile(statePath, "utf8"));
  const schedules = await cf(`/workers/scripts/${productionWorker}/schedules`);
  if (!schedules.some((schedule) => schedule.cron === "*/10 * * * *")) {
    throw new Error("Production scheduler trigger is missing.");
  }

  const deadline = Date.now() + 12 * 60 * 1000;
  while (true) {
    const [checkpoint] = await cf(`/d1/database/${databaseId}/query`, {
      method: "POST",
      body: JSON.stringify({
        sql: "SELECT last_successful_at, (SELECT state FROM tasks WHERE repository=? AND issue_number=?) AS issue_state FROM project_reconciliation_checkpoint ORDER BY last_successful_at DESC LIMIT 1",
        params: ["noahpeters/from-trees-studio", 1],
      }),
    });
    const row = checkpoint.results?.[0];
    if (row?.last_successful_at >= state.startedAt && row.issue_state) break;
    if (Date.now() >= deadline) {
      throw new Error("No fresh Project reconciliation admitted noahpeters/from-trees-studio#1.");
    }
    await new Promise((resolve) => setTimeout(resolve, 30_000));
  }

  if (state.promoted) {
    await cf(`/workers/workers/${state.replacedWorkerId}`, { method: "DELETE" });
  }
  if (await findWorker(credentialWorker)) {
    throw new Error(`${credentialWorker} still exists after promotion.`);
  }

  const queues = await cf("/queues?per_page=100");
  for (const name of ["metis-dispatch-staging", "metis-dead-letter-staging"]) {
    const queue = queues.find((candidate) => candidate.queue_name === name || candidate.name === name);
    if (queue) await cf(`/queues/${queue.queue_id || queue.id}`, { method: "DELETE" });
  }
  const remaining = await cf("/queues?per_page=100");
  const obsolete = remaining.filter((queue) => (queue.queue_name || queue.name).endsWith("-staging"));
  if (obsolete.length) throw new Error(`Obsolete queues remain: ${obsolete.map((queue) => queue.queue_name || queue.name).join(", ")}`);
}

await (mode === "prepare" ? prepare() : finalize());
console.log(`Production cutover ${mode} checks passed.`);
