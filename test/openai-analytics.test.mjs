import test from "node:test";
import assert from "node:assert/strict";
import { ingestOpenAIAnalytics } from "../src/openai-analytics.mjs";

function environment(overrides = {}) {
  const calls = [];
  return {
    calls,
    env: {
      OPENAI_ANALYTICS_ADMIN_KEY: "admin-secret",
      OPENAI_ANALYTICS_ORG_ID: "org_1",
      OPENAI_ANALYTICS_WORKSPACE_REF: "api-org-internal-1",
      DB: { prepare(sql) { return { bind(...values) { return { async run() { calls.push({ sql, values }); } }; } }; } },
      ...overrides,
    },
  };
}

function response(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers });
}

test("ingests documented bucket shapes, pagination, and separate billing scope", async () => {
  const { env, calls } = environment();
  const urls = [];
  const pages = [
    response({ object: "page", data: [{ object: "bucket", start_time: 100, end_time: 200, results: [{ object: "organization.usage.completions.result", input_tokens: 7, output_tokens: 3, num_model_requests: 1, model: "gpt-test", project_id: null, user_id: null, api_key_id: null, batch: null }] }], has_more: true, next_page: "cursor-2" }),
    response({ object: "page", data: [{ object: "bucket", start_time: 200, end_time: 300, results: [{ input_tokens: 2, output_tokens: 1, num_model_requests: 1 }] }], has_more: false, next_page: null }),
    response({ object: "page", data: [{ object: "bucket", start_time: 100, end_time: 200, results: [{ object: "organization.costs.result", amount: { value: 0.25, currency: "usd" }, line_item: "api usage", project_id: null }] }], has_more: false, next_page: null }),
  ];
  const result = await ingestOpenAIAnalytics(env, { now: 1_000_000, fetchImpl: async (url, init) => {
    urls.push(String(url));
    assert.equal(init.headers.Authorization, "Bearer admin-secret");
    return pages.shift();
  } });
  assert.equal(result.observations, 3);
  assert.match(urls[1], /page=cursor-2/);
  assert.equal(calls.length, 3);
  assert.ok(calls.every(({ values }) => !values.includes("admin-secret")));
  assert.ok(calls.some(({ values }) => values.includes(10)));
  assert.ok(calls.some(({ values }) => values.some((value) => typeof value === "string" && value.includes('"amount":0.25') && value.includes('"billing_scope":"api_platform"'))));
});

test("re-reading duplicates is idempotent while corrected aggregates get a revision", async () => {
  const { env, calls } = environment();
  const fetchRun = (tokens) => ingestOpenAIAnalytics(env, { now: 1_000_000, fetchImpl: async (url) => response({ data: String(url).includes("/costs") ? [] : [{ start_time: 100, end_time: 200, results: [{ input_tokens: tokens, output_tokens: 1 }] }], has_more: false }) });
  await fetchRun(4); await fetchRun(4); await fetchRun(5);
  const usage = calls.filter(({ values }) => values.includes("api_usage"));
  const revisionIndex = usage[0].sql.slice(0, usage[0].sql.indexOf(",created_at")).split(",").indexOf("source_revision");
  assert.equal(usage[0].values[revisionIndex], usage[1].values[revisionIndex]);
  assert.notEqual(usage[1].values[revisionIndex], usage[2].values[revisionIndex]);
  assert.match(usage[0].sql, /ON CONFLICT DO NOTHING/);
});

test("honors reporting delay and retries a rate-limited page", async () => {
  const { env } = environment();
  let attempts = 0;
  const sleeps = [];
  const urls = [];
  await ingestOpenAIAnalytics(env, { now: 1_000_000, sleep: async (ms) => sleeps.push(ms), fetchImpl: async (url) => {
    urls.push(String(url)); attempts += 1;
    if (attempts === 1) return response({}, 429, { "retry-after": "2" });
    return response({ data: [], has_more: false });
  } });
  assert.deepEqual(sleeps, [2000]);
  assert.ok(urls.every((url) => url.includes("end_time=999700")));
});

test("credential failure is observable without exposing the credential", async () => {
  const { env, calls } = environment();
  const result = await ingestOpenAIAnalytics(env, { now: 1_000_000, fetchImpl: async () => response({ error: { message: "secret echoed by provider" } }, 401) });
  assert.equal(result.status, "ok");
  assert.equal(calls.length, 2);
  assert.ok(calls.every(({ values }) => values.includes("not_authorized") && !values.some((value) => String(value).includes("secret"))));
});

test("missing deployment credential disables collection without a network call", async () => {
  const { env } = environment({ OPENAI_ANALYTICS_ADMIN_KEY: undefined });
  let fetched = false;
  const result = await ingestOpenAIAnalytics(env, { fetchImpl: async () => { fetched = true; } });
  assert.deepEqual(result, { status: "disabled", observations: 0 });
  assert.equal(fetched, false);
});
