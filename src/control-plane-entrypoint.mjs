import { WorkerEntrypoint } from "cloudflare:workers";
import worker, { resumeReadyBacklog, uiStatusForIdentity } from "./index.mjs";
import { pacingOverviewForIdentity, resetPacingWindowForIdentity } from "./pacing-api.mjs";

async function rpcResult(response) {
  return { status: response.status, body: await response.text() };
}

export default class MetisControlPlane extends WorkerEntrypoint {
  fetch(request) { return worker.fetch(request, this.env); }
  queue(batch) { return worker.queue(batch, this.env); }
  scheduled(controller) { return worker.scheduled(controller, this.env); }

  async uiStatus(email) {
    return rpcResult(uiStatusForIdentity(email));
  }

  async pacingOverview(email) {
    return rpcResult(await pacingOverviewForIdentity(email, this.env));
  }

  async resetPacingWindow(email, body, idempotencyKey) {
    const request = new Request("https://rpc.invalid/internal/ui/pacing/reset", {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": idempotencyKey || "" },
      body: JSON.stringify(body),
    });
    return rpcResult(await resetPacingWindowForIdentity(email, request, this.env, () => resumeReadyBacklog(this.env)));
  }
}
