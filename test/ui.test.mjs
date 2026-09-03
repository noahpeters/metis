import assert from "node:assert/strict";
import test from "node:test";
import { allowedApiRequest, streamSnapshots } from "../src/ui/api.mjs";
import { authenticate, emailAllowed } from "../src/ui/auth.mjs";
import { uiStatusForIdentity } from "../src/index.mjs";
import { proxyApi } from "../src/ui/api.mjs";
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

test("API allowlist preserves streaming and pacing actions", () => {
  assert.equal(allowedApiRequest("GET", "/api/status"), true);
  assert.equal(allowedApiRequest("POST", "/api/status"), false);
  assert.equal(allowedApiRequest("GET", "/api/tasks"), false);
  assert.equal(allowedApiRequest("GET", "/api/pacing"), true);
  assert.equal(allowedApiRequest("POST", "/api/pacing/reset"), false);
  assert.equal(allowedApiRequest("POST", "/api/pacing/nudge"), true);
  assert.equal(allowedApiRequest("POST", "/api/capacity/reenergize"), true);
  assert.equal(allowedApiRequest("GET", "/api/stream"), true);
  assert.equal(allowedApiRequest("POST", "/api/stream"), false);
  assert.equal(allowedApiRequest("GET", "/api/pacing/nudge"), false);
});

test("nudge proxy forwards only the authenticated identity", async () => {
  const calls = [];
  const env = { CONTROL_PLANE: { async nudgeReadyWork(email) { calls.push(email); return { status: 200, body: JSON.stringify({ reconciled: true, admitted: 1 }) }; } } };
  const response = await proxyApi(new Request("https://ui/api/pacing/nudge", { method: "POST" }), env, { email: "admin@from-trees.com" });
  assert.equal(response.status, 200);
  assert.deepEqual(calls, ["admin@from-trees.com"]);
});

test("reenergize proxy forwards authenticated identity and bounded body", async () => {
  const calls = [];
  const env = { CONTROL_PLANE: { async reenergizeCapacity(email, body) { calls.push({ email, body }); return { status: 200, body: JSON.stringify({ reenergized: true }) }; } } };
  const body = { confirmation: "REENERGIZE_CAPACITY", request_id: "request-1" };
  const response = await proxyApi(new Request("https://ui/api/capacity/reenergize", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), env, { email: "admin@from-trees.com" });
  assert.equal(response.status, 200);
  assert.deepEqual(calls, [{ email: "admin@from-trees.com", body }]);
});

test("snapshot stream is identity scoped and carries monotonic revisions", async () => {
  const calls = [];
  const request = new Request("https://ui/api/stream");
  const response = streamSnapshots(request, {
    UI_STREAM_INTERVAL_MS: "100",
    UI_STREAM_LIFETIME_MS: "220",
    CONTROL_PLANE: { async pacingOverview(email) { calls.push(email); return { status: 200, body: JSON.stringify({ pacing: { value: calls.length } }) }; } },
  }, { email: "admin@from-trees.com" });
  assert.match(response.headers.get("content-type"), /^text\/event-stream/);
  const payload = await response.text();
  const events = [...payload.matchAll(/^data: (.+)$/gm)].map((match) => JSON.parse(match[1]));
  assert.ok(events.length >= 2);
  assert.deepEqual(events.slice(0, 2).map(({ revision }) => revision), [1, 2]);
  assert.equal(events[0].stream_id, events[1].stream_id);
  assert.ok(calls.every((email) => email === "admin@from-trees.com"));
});

test("control plane RPC re-authorizes the forwarded identity", async () => {
  assert.equal(uiStatusForIdentity("admin@from-trees.com").status, 200);
  assert.equal(uiStatusForIdentity("admin@example.com").status, 401);
  const calls = [];
  const env = { CONTROL_PLANE: { async pacingOverview(email) { calls.push(email); return { status: 200, body: JSON.stringify({ ok: true }) }; } } };
  const response = await proxyApi(new Request("https://ui/api/pacing"), env, { email: "admin@from-trees.com" });
  assert.equal(response.status, 200);
  assert.deepEqual(calls, ["admin@from-trees.com"]);
});

test("SSR fails closed and never caches unauthorized state", async () => {
  const response = await uiWorker.fetch(new Request("https://ui/"), {});
  assert.equal(response.status, 401);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.match(await response.text(), /Access denied/);
});

test("authenticated shell exposes capacity status without a budget reset", async () => {
  const response = await uiWorker.fetch(new Request("https://ui/"), { ENVIRONMENT: "local", LOCAL_AUTH_ENABLED: "true", LOCAL_AUTH_EMAIL: "admin@from-trees.com" });
  const html = await response.text();
  assert.match(html, /Loading capacity status/);
  assert.match(html, /href="\/app\.css"/);
  assert.match(html, /src="\/app\.js"/);
  assert.doesNotMatch(html, /\/assets\/app\.(?:css|js)/);
  assert.match(html, /id="live-status"[^>]*data-state="connecting"/);
  assert.match(html, /<button id="nudge" type="button" hidden>Nudge<\/button>/);
  assert.match(html, /<button id="reenergize" type="button" hidden>Reenergize<\/button>/);
  assert.doesNotMatch(html, /Reset budget|reset-dialog|open-reset/);
  assert.match(html, /minlength="8"/);
  assert.match(html, /aria-live="assertive"/);
});

test("UI serves every referenced asset from the asset binding", async () => {
  const seen = [];
  const env = { ASSETS: { fetch(request) { seen.push(new URL(request.url).pathname); return new Response("asset"); } } };
  for (const path of ["/app.css", "/app.js", "/pacing.js"]) assert.equal((await uiWorker.fetch(new Request(`https://ui${path}`), env)).status, 200);
  assert.deepEqual(seen, ["/app.css", "/app.js", "/pacing.js"]);
});

test("UI API exposes only bounded repository diagnostics and revalidation", () => {
  assert.equal(allowedApiRequest("GET", "/api/repositories"), true);
  assert.equal(allowedApiRequest("POST", "/api/repositories/revalidate"), true);
  assert.equal(allowedApiRequest("POST", "/api/issues/reset-ready"), true);
  assert.equal(allowedApiRequest("POST", "/api/issues/force-complete"), true);
  assert.equal(allowedApiRequest("DELETE", "/api/repositories"), false);
});
