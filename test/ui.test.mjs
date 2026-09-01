import assert from "node:assert/strict";
import test from "node:test";
import { allowedApiRequest } from "../src/ui/api.mjs";
import { authenticate, emailAllowed } from "../src/ui/auth.mjs";
import { authorizeUiBinding } from "../src/index.mjs";
import uiWorker from "../src/ui/worker.mjs";

test("authorization matches only the exact organization domain", () => {
  assert.equal(emailAllowed("Person@FROM-TREES.COM"), true);
  assert.equal(emailAllowed("person@evilfrom-trees.com"), false);
  assert.equal(emailAllowed("@from-trees.com"), false);
});

test("deployed auth requires the identity header injected by Cloudflare Access", async () => {
  await assert.rejects(authenticate(new Request("https://ui/"), { ENVIRONMENT: "production" }));
  await assert.rejects(authenticate(new Request("https://ui/", { headers: { "Cf-Access-Authenticated-User-Email": "user@example.com" } }), { ENVIRONMENT: "production" }));
  assert.equal((await authenticate(new Request("https://ui/", { headers: { "Cf-Access-Authenticated-User-Email": "User@FROM-TREES.COM" } }), { ENVIRONMENT: "production" })).email, "user@from-trees.com");
});

test("local auth is explicit and cannot be enabled in a deployed environment", async () => {
  await assert.rejects(authenticate(new Request("https://ui/"), { ENVIRONMENT: "production", LOCAL_AUTH_ENABLED: "true", LOCAL_AUTH_EMAIL: "dev@from-trees.com" }));
  assert.equal((await authenticate(new Request("https://ui/"), { ENVIRONMENT: "local", LOCAL_AUTH_ENABLED: "true", LOCAL_AUTH_EMAIL: "dev@from-trees.com" })).email, "dev@from-trees.com");
});

test("API allowlist permits only read-only status", () => {
  assert.equal(allowedApiRequest("GET", "/api/status"), true);
  assert.equal(allowedApiRequest("POST", "/api/status"), false);
  assert.equal(allowedApiRequest("GET", "/api/tasks"), false);
  assert.equal(allowedApiRequest("GET", "/api/pacing"), true);
  assert.equal(allowedApiRequest("POST", "/api/pacing/reset"), true);
});

test("control plane re-authorizes verified binding context", () => {
  assert.equal(authorizeUiBinding(new Request("https://cp/internal/ui/status", { headers: { "X-Metis-Verified-Email": "admin@from-trees.com", "CF-Worker": "from-trees.com" } })), true);
  assert.equal(authorizeUiBinding(new Request("https://cp/internal/ui/status", { headers: { "X-Metis-Verified-Email": "admin@from-trees.com" } })), false);
  assert.equal(authorizeUiBinding(new Request("https://cp/internal/ui/status", { headers: { "X-Metis-Verified-Email": "admin@from-trees.com", "CF-Worker": "evil.example" } })), false);
  assert.equal(authorizeUiBinding(new Request("https://cp/internal/ui/status", { headers: { "Cf-Access-Authenticated-User-Email": "admin@from-trees.com", "CF-Worker": "from-trees.com" } })), false);
});

test("SSR fails closed and never caches unauthorized state", async () => {
  const response = await uiWorker.fetch(new Request("https://ui/"), {});
  assert.equal(response.status, 401);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.match(await response.text(), /Access denied/);
});

test("authenticated shell exposes accessible pacing and confirmation states", async () => {
  const response = await uiWorker.fetch(new Request("https://ui/"), { ENVIRONMENT: "local", LOCAL_AUTH_ENABLED: "true", LOCAL_AUTH_EMAIL: "admin@from-trees.com" });
  const html = await response.text();
  assert.match(html, /Loading pacing status/);
  assert.match(html, /href="\/app\.css"/);
  assert.match(html, /src="\/app\.js"/);
  assert.doesNotMatch(html, /\/assets\/app\.(?:css|js)/);
  assert.match(html, /<dialog id="reset-dialog"/);
  assert.match(html, /does not reset ChatGPT or Codex/);
  assert.match(html, /minlength="8"/);
  assert.match(html, /aria-live="assertive"/);
});

test("UI serves every referenced asset from the asset binding", async () => {
  const seen = [];
  const env = { ASSETS: { fetch(request) { seen.push(new URL(request.url).pathname); return new Response("asset"); } } };
  for (const path of ["/app.css", "/app.js", "/pacing.js"]) assert.equal((await uiWorker.fetch(new Request(`https://ui${path}`), env)).status, 200);
  assert.deepEqual(seen, ["/app.css", "/app.js", "/pacing.js"]);
});
