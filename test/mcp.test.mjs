import test from "node:test";
import assert from "node:assert/strict";
import { handleMcp } from "../src/mcp.mjs";

const env = { METIS_MCP_BEARER_TOKEN: "test-only-secret" };
const request = (method, params, token = "test-only-secret") => new Request("https://metis.invalid/mcp", {
  method: "POST",
  headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
});
test("MCP rejects missing and invalid credentials", async () => {
  assert.equal((await handleMcp(request("tools/list", {}, null), env)).status, 401);
  assert.equal((await handleMcp(request("tools/list", {}, "incorrect"), env)).status, 401);
  assert.equal((await handleMcp(request("tools/list"), {})).status, 401);
});
test("MCP initializes and exposes only metis_ping", async () => {
  const init = await (await handleMcp(request("initialize"), env)).json();
  assert.equal(init.result.serverInfo.name, "metis");
  const list = await (await handleMcp(request("tools/list"), env)).json();
  assert.deepEqual(list.result.tools.map((t) => t.name), ["metis_ping"]);
});
test("MCP ping is read only and unknown tools are rejected", async () => {
  const ping = await (await handleMcp(request("tools/call", { name: "metis_ping", arguments: {} }), env)).json();
  assert.equal(JSON.parse(ping.result.content[0].text).status, "operational");
  const unknown = await (await handleMcp(request("tools/call", { name: "dispatch_task" }), env)).json();
  assert.equal(unknown.error.code, -32602);
});
