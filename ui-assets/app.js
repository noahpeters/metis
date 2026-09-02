import { derivePacingView, formatExactTime, relativeUntil } from "./pacing.js";

const card = document.querySelector("#pacing-card");
const dialog = document.querySelector("#reset-dialog");
const form = document.querySelector("#reset-form");
const announcement = document.querySelector("#announcement");
const resetButton = document.querySelector("#open-reset");
const nudgeButton = document.querySelector("#nudge");
const actions = document.querySelector("#pacing-actions");
let verifiedOverview = null;

class ApiError extends Error {
  constructor(body, status) {
    super(body.error?.message || "Request failed");
    this.code = body.error?.code || "request_failed";
    this.status = status;
  }
}

async function api(path, options) {
  const response = await fetch(path, { ...options, headers: { accept: "application/json", ...options?.headers } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(body, response.status);
  return body;
}

const text = (parent, name, value) => {
  const element = document.createElement(name);
  element.textContent = value;
  parent.append(element);
  return element;
};

function render(overview, stale = false, error = "") {
  const view = derivePacingView(overview);
  card.dataset.state = view.tone;
  card.setAttribute("aria-busy", "false");
  card.replaceChildren();

  const visual = document.createElement("div");
  visual.className = "status-visual";
  visual.setAttribute("role", "img");
  visual.setAttribute("aria-label", `${view.label}. ${view.reason}`);
  const circle = document.createElement("span");
  circle.className = "status-circle";
  circle.setAttribute("aria-hidden", "true");
  visual.append(circle);

  const details = document.createElement("div");
  details.className = "status-details";
  text(details, "p", "LOCAL PACING ESTIMATE").className = "eyebrow";
  const amount = document.createElement("p");
  amount.className = "amount";
  text(amount, "strong", view.used);
  text(amount, "span", ` / ${view.limit}`);
  details.append(amount);
  text(details, "h1", view.label);
  text(details, "p", view.reason).className = view.warning ? "reason warning" : "reason";

  const reset = document.createElement("p");
  reset.className = "reset-time";
  text(reset, "span", "Next scheduled reset ");
  const time = text(reset, "time", formatExactTime(overview?.window?.next_scheduled_reset_at));
  if (overview?.window?.next_scheduled_reset_at) time.dateTime = overview.window.next_scheduled_reset_at;
  text(reset, "span", ` (${relativeUntil(overview?.window?.next_scheduled_reset_at)})`);
  details.append(reset);

  const meta = document.createElement("p");
  meta.className = "meta";
  meta.textContent = `${stale ? "Stale — last verified " : "Observed "}${formatExactTime(overview?.observed_at)} · Task starts ${view.startsUsed} / ${view.startsLimit}`;
  details.append(meta);
  if (error) text(details, "p", error).className = "error";
  details.append(actions);
  card.append(visual, details);
  resetButton.hidden = false;
  nudgeButton.hidden = !view.nudgeAllowed;
  resetButton.disabled = !overview?.window?.id;
}

async function refresh() {
  try {
    const overview = await api("/api/pacing");
    verifiedOverview = overview;
    render(overview);
  } catch (error) {
    if (verifiedOverview) render(verifiedOverview, true, "Refresh failed. Last verified values are preserved; retry when ready.");
    else {
      card.dataset.state = "unknown";
      card.innerHTML = '<div class="status-details"><p class="eyebrow">LOCAL PACING ESTIMATE</p><h1>Status unknown</h1><p class="reason">No verified pacing observation is available.</p><button id="retry" type="button">Retry</button></div>';
      card.querySelector("#retry").addEventListener("click", refresh);
    }
  }
}

nudgeButton.addEventListener("click", async () => {
  nudgeButton.disabled = true;
  nudgeButton.textContent = "Nudging…";
  announcement.textContent = "Nudge in progress. Metis is checking Ready work.";
  try {
    const result = await api("/api/pacing/nudge", { method: "POST" });
    announcement.textContent = result.admitted > 0
      ? `Nudge succeeded. ${result.admitted} ${result.admitted === 1 ? "task was" : "tasks were"} admitted.`
      : "Nudge succeeded. No Ready work was admitted; refreshed status explains what remains waiting.";
    await refresh();
  } catch (error) {
    announcement.textContent = `Nudge failed: ${error.message}. You can safely retry.`;
    await refresh();
  } finally {
    nudgeButton.disabled = false;
    nudgeButton.textContent = "Nudge";
  }
});

resetButton.addEventListener("click", () => {
  const view = derivePacingView(verifiedOverview);
  document.querySelector("#current-window").textContent = verifiedOverview.window.id;
  document.querySelector("#current-counters").textContent = `${view.used} / ${view.limit} workload units; ${view.startsUsed} / ${view.startsLimit} task starts`;
  dialog.showModal();
  form.elements.reason.focus();
});
document.querySelector("#cancel-reset").addEventListener("click", () => dialog.close());

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const submit = form.querySelector('[type="submit"]');
  const reason = new FormData(form).get("reason");
  submit.disabled = true;
  form.setAttribute("aria-busy", "true");
  try {
    const result = await api("/api/pacing/reset", {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify({ confirmation: "START_NEW_PACING_WINDOW", expected_window_id: verifiedOverview.window.id, request_id: crypto.randomUUID(), reason }),
    });
    form.reset();
    dialog.close();
    announcement.textContent = result.duplicate ? "Reset already applied. Pacing status refreshed." : "Reset succeeded. A new local pacing window is active.";
    await refresh();
  } catch (error) {
    const stale = !error.code || error.code === "stale_window" || error.status >= 500 || error.code === "request_failed";
    render(verifiedOverview, stale, `${error.message}. Verified values were not changed.`);
    dialog.close();
    announcement.textContent = `Reset failed: ${error.message}. You can safely retry.`;
  } finally {
    submit.disabled = false;
    form.removeAttribute("aria-busy");
  }
});

refresh();
