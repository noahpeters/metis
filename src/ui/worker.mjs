import { authenticate } from "./auth.mjs";
import { proxyApi } from "./api.mjs";

const shell = (email) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>metis · pacing</title><link rel="stylesheet" href="/app.css"></head><body><a class="skip" href="#main">Skip to content</a><header><strong>metis</strong><div><span id="live-status" class="live-status" data-state="connecting" role="status">Connecting…</span><span>${escapeHtml(email)}</span></div></header><main id="main"><div id="pacing-card" class="pacing-card" data-state="loading" aria-live="polite" aria-busy="true"><div class="status-visual"><span class="status-circle skeleton"></span></div><div class="status-details"><p class="eyebrow">LOCAL PACING ESTIMATE</p><h1>Loading pacing status…</h1><p class="reason">Retrieving the latest verified control-plane observation.</p></div></div><button id="open-reset" type="button" hidden>Reset budget</button><p id="announcement" class="sr-only" role="status" aria-live="assertive"></p></main><dialog id="reset-dialog" aria-labelledby="reset-title"><form id="reset-form" method="dialog"><p class="eyebrow">ADMINISTRATOR ACTION</p><h2 id="reset-title">Reset local pacing budget?</h2><p>This starts a new local pacing window. It does not reset ChatGPT or Codex credits, tokens, or included allowance.</p><dl><div><dt>Current window</dt><dd id="current-window"></dd></div><div><dt>Current counters</dt><dd id="current-counters"></dd></div></dl><label for="reset-reason">Reason</label><textarea id="reset-reason" name="reason" minlength="8" maxlength="500" required rows="3" placeholder="Why is a new window needed?"></textarea><div class="dialog-actions"><button id="cancel-reset" class="secondary" type="button">Cancel</button><button type="submit">Start new window</button></div></form></dialog><script type="module" src="/app.js"></script></body></html>`;
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const assetPaths = new Set(["/app.css", "/app.js", "/pacing.js"]);

export default { async fetch(request, env) {
  const url = new URL(request.url);
  if (assetPaths.has(url.pathname)) return env.ASSETS.fetch(request);
  try {
    const identity = await authenticate(request, env);
    if (url.pathname.startsWith("/api/")) return proxyApi(request, env, identity);
    if (request.method !== "GET" || url.pathname !== "/") return new Response("Not found", { status: 404, headers: { "cache-control": "no-store" } });
    return new Response(shell(identity.email), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": "default-src 'self'; frame-ancestors 'none'; base-uri 'none'" } });
  } catch {
    return new Response("<!doctype html><title>Unauthorized · metis</title><main><h1>Access denied</h1><p>A verified from-trees.com identity is required.</p></main>", { status: 401, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
  }
} };
