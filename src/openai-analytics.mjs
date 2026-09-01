import { providerObservationStatement } from "./provider-capacity.mjs";

const API_ORIGIN = "https://api.openai.com";
const SURFACES = [
  { name: "completions", path: "/v1/organization/usage/completions", eventClass: "api_usage" },
  { name: "costs", path: "/v1/organization/costs", eventClass: "api_cost" },
];
const LOOKBACK_SECONDS = 7 * 24 * 60 * 60;
const REPORTING_DELAY_SECONDS = 5 * 60;
const MAX_PAGES = 100;

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

async function digest(value) {
  const bytes = new TextEncoder().encode(canonical(value));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function optionalNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

async function requestPage(url, env, fetchImpl, sleep) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await fetchImpl(url, { headers: { Authorization: `Bearer ${env.OPENAI_ANALYTICS_ADMIN_KEY}`, "OpenAI-Organization": env.OPENAI_ANALYTICS_ORG_ID } });
    if (response.status !== 429 || attempt === 2) return response;
    const retryAfter = Math.min(30, Math.max(0, Number(response.headers.get("retry-after")) || 1));
    await sleep(retryAfter * 1000);
  }
}

async function writeUnavailable(env, surface, now, status) {
  await providerObservationStatement(env, {
    provider: "openai_api", workspace_ref: env.OPENAI_ANALYTICS_WORKSPACE_REF ?? null,
    event_class: surface.eventClass, classification: "unavailable", freshness: "unknown",
    observed_at: now, sanitized_status: status, deduplication_key: `${surface.name}:unavailable:${Math.floor(now / 3600)}`,
    source_revision: "v1", derived_metrics: { billing_scope: "api_platform", reason: status },
  }).run();
}

function observation(surface, bucket, result, context) {
  const dimensions = {};
  for (const key of ["model", "project_id", "user_id", "api_key_id", "batch", "line_item"]) {
    if (result[key] !== undefined && result[key] !== null) dimensions[key] = result[key];
  }
  const input = optionalNumber(result.input_tokens);
  const output = optionalNumber(result.output_tokens);
  return {
    provider: "openai_api", workspace_ref: context.workspaceRef, provider_ref: null,
    event_class: surface.eventClass, classification: "unattributed", observed_at: bucket.end_time,
    provider_window_start: bucket.start_time, provider_window_end: bucket.end_time, provider_timezone: "UTC",
    freshness: bucket.end_time <= context.windowEnd ? "fresh" : "unknown", sanitized_status: "reported",
    input_tokens: input, output_tokens: output, total_tokens: input !== null && output !== null ? input + output : null,
    model: result.model ?? null,
    deduplication_key: `${surface.name}:${bucket.start_time}:${bucket.end_time}:${canonical(dimensions)}`,
    pagination_checkpoint: context.nextPage, reconciliation_state: "reconciled",
    derived_metrics: { billing_scope: "api_platform", dimensions, num_model_requests: optionalNumber(result.num_model_requests), amount: optionalNumber(result.amount?.value), currency: result.amount?.currency ?? null },
  };
}

// These endpoints report separate API-platform aggregates. They are never
// interpreted as ChatGPT-plan allowance and never change the dispatch gate.
export async function ingestOpenAIAnalytics(env, options = {}) {
  if (!env.OPENAI_ANALYTICS_ADMIN_KEY || !env.OPENAI_ANALYTICS_ORG_ID || !env.OPENAI_ANALYTICS_WORKSPACE_REF) return { status: "disabled", observations: 0 };
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const windowEnd = now - REPORTING_DELAY_SECONDS;
  const windowStart = windowEnd - LOOKBACK_SECONDS;
  let written = 0;
  for (const surface of SURFACES) {
    let page;
    for (let pageCount = 0; pageCount < MAX_PAGES; pageCount += 1) {
      const url = new URL(surface.path, API_ORIGIN);
      url.searchParams.set("start_time", String(windowStart));
      url.searchParams.set("end_time", String(windowEnd));
      url.searchParams.set("bucket_width", "1d");
      if (page) url.searchParams.set("page", page);
      let response;
      try { response = await requestPage(url, env, fetchImpl, sleep); }
      catch { await writeUnavailable(env, surface, now, "network_unavailable"); break; }
      if (!response.ok) {
        const status = response.status === 401 || response.status === 403 ? "not_authorized" : response.status === 429 ? "rate_limited" : "api_unavailable";
        await writeUnavailable(env, surface, now, status);
        break;
      }
      const body = await response.json();
      if (!Array.isArray(body.data)) { await writeUnavailable(env, surface, now, "missing_data"); break; }
      const nextPage = body.next_page ?? null;
      for (const bucket of body.data) for (const result of Array.isArray(bucket.results) ? bucket.results : []) {
        const input = observation(surface, bucket, result, { workspaceRef: env.OPENAI_ANALYTICS_WORKSPACE_REF, windowEnd, nextPage });
        input.source_revision = await digest({ result, start_time: bucket.start_time, end_time: bucket.end_time });
        await providerObservationStatement(env, input).run();
        written += 1;
      }
      if (!body.has_more || !nextPage) break;
      page = nextPage;
    }
  }
  return { status: "ok", observations: written, windowStart, windowEnd };
}
