import assert from "node:assert/strict";
import test from "node:test";
import { allowedApiRequest } from "../src/ui/api.mjs";
import { authenticate, emailAllowed, verifyAccessJwt } from "../src/ui/auth.mjs";
import { authorizeUiBinding } from "../src/index.mjs";
import uiWorker from "../src/ui/worker.mjs";

test("authorization matches only the exact organization domain", () => {
  assert.equal(emailAllowed("Person@FROM-TREES.COM"), true);
  assert.equal(emailAllowed("person@evilfrom-trees.com"), false);
  assert.equal(emailAllowed("@from-trees.com"), false);
});

test("JWT verifier rejects malformed, expired, issuer, and audience claims before key lookup", async () => {
  const part = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = part({ alg: "RS256", kid: "one" });
  const base = { iss: "https://team.cloudflareaccess.com", aud: "aud", exp: 200, email: "user@from-trees.com" };
  for (const claims of [{ ...base, exp: 1 }, { ...base, iss: "https://evil.invalid" }, { ...base, aud: "wrong" }, { ...base, email: "user@example.com" }]) {
    await assert.rejects(verifyAccessJwt(`${header}.${part(claims)}.AA`, { teamDomain: "team", audience: "aud" }, () => assert.fail("must not fetch"), 100_000));
  }
  await assert.rejects(verifyAccessJwt("not-a-jwt", { teamDomain: "team", audience: "aud" }));
});

test("local auth is explicit and cannot be enabled in a deployed environment", async () => {
  await assert.rejects(authenticate(new Request("https://ui/"), { ENVIRONMENT: "staging", LOCAL_AUTH_ENABLED: "true", LOCAL_AUTH_EMAIL: "dev@from-trees.com" }));
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
  const env = { UI_BINDING_TOKEN: "secret" };
  assert.equal(authorizeUiBinding(new Request("https://cp/internal/ui/status", { headers: { "X-Metis-Verified-Email": "admin@from-trees.com", "X-Metis-UI-Binding": "secret" } }), env), true);
  assert.equal(authorizeUiBinding(new Request("https://cp/internal/ui/status", { headers: { "Cf-Access-Authenticated-User-Email": "admin@from-trees.com" } }), env), false);
});

test("SSR fails closed and never caches unauthorized state", async () => {
  const response = await uiWorker.fetch(new Request("https://ui/"), {});
  assert.equal(response.status, 401);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.match(await response.text(), /Access denied/);
});
