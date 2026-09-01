import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";

import worker from "../../src/ui/worker.mjs";

const host = "127.0.0.1";
const port = 8788;
const assetsDirectory = resolve("ui-assets");
const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
]);

const assets = {
  async fetch(request) {
    const pathname = new URL(request.url).pathname;
    const filename = pathname.replace(/^\/assets\//, "");
    if (!filename || filename.includes("/") || filename.includes("\\")) return new Response("Not found", { status: 404 });
    try {
      const body = await readFile(resolve(assetsDirectory, filename));
      return new Response(body, { headers: { "content-type": contentTypes.get(extname(filename)) || "application/octet-stream" } });
    } catch (error) {
      if (error.code === "ENOENT") return new Response("Not found", { status: 404 });
      throw error;
    }
  },
};

const env = {
  ASSETS: assets,
  ENVIRONMENT: "local",
  LOCAL_AUTH_ENABLED: "true",
  LOCAL_AUTH_EMAIL: "ui-test@from-trees.com",
};

const server = createServer(async (incoming, outgoing) => {
  try {
    const request = new Request(`http://${host}:${port}${incoming.url}`, {
      method: incoming.method,
      headers: incoming.headers,
    });
    const response = await worker.fetch(request, env);
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    console.error(error);
    outgoing.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    outgoing.end("Internal server error");
  }
});

server.listen(port, host, () => console.log(`UI test server listening on http://${host}:${port}`));

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
