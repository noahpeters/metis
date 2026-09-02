import { derivePacingView, formatExactTime, relativeUntil } from "./pacing.js";

const card = document.querySelector("#pacing-card");
const dialog = document.querySelector("#reset-dialog");
const form = document.querySelector("#reset-form");
const announcement = document.querySelector("#announcement");
const resetButton = document.querySelector("#open-reset");
const repositoryCards = document.querySelector("#repository-cards");
const revalidateDialog = document.querySelector("#revalidate-dialog");
const revalidateForm = document.querySelector("#revalidate-form");
const nudgeButton = document.querySelector("#nudge") || document.createElement("button");
const actions = document.querySelector("#pacing-actions") || document.createElement("div");
if (!actions.id) {
  actions.id = "pacing-actions";
  actions.className = "pacing-actions";
  nudgeButton.id = "nudge";
  nudgeButton.type = "button";
  nudgeButton.textContent = "Nudge";
  resetButton.className = "secondary";
  actions.append(nudgeButton, resetButton);
}
let verifiedOverview = null;
let selectedRepository = null;

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

function renderRepositories(overview) {
  repositoryCards.replaceChildren(); repositoryCards.setAttribute("aria-busy", "false");
  for (const repository of overview.repositories) {
    const item = document.createElement("article"); item.className = "repository-card"; item.dataset.health = repository.dispatch_locked ? "locked" : repository.ready_count ? "ready" : "idle";
    const heading = document.createElement("div"); heading.className = "repository-heading"; text(heading, "h3", repository.repository); text(heading, "span", repository.dispatch_locked ? "Recovery Locked" : repository.ready_count ? "Backlog ready" : "Backlog idle").className = "state-pill"; item.append(heading);
    text(item, "p", repository.dispatch_locked ? repository.waiting_reason : `${repository.ready_count} Ready issue${repository.ready_count === 1 ? "" : "s"}.`).className = "reason";
    if (repository.dispatch_locked) {
      const evidence = document.createElement("dl"); evidence.className = "evidence-list";
      const add = (name, value, href) => { const row = document.createElement("div"); text(row, "dt", name); const dd = document.createElement("dd"); const node = text(dd, href ? "a" : "span", value || "Not observed"); if (href) { node.href = href; node.target = "_blank"; node.rel = "noreferrer"; } row.append(dd); evidence.append(row); };
      add("Blocking commit", repository.blocking_sha?.slice(0, 12), repository.workflow_url); add("Root task", repository.root_task_id); add("Recovery issue", repository.recovery_task ? `#${repository.recovery_task.issue_number} · ${repository.recovery_task.state}` : null); add("Recovery PR", repository.recovery_pr ? `#${repository.recovery_pr.number} · ${repository.recovery_pr.state.replaceAll("_", " ")}` : null, repository.recovery_pr?.url); add("Attempts", String(repository.recovery_attempts)); add("Evidence policy", repository.evidence_policy.replaceAll("_", " ")); add("Last transition", repository.updated_at ? new Date(repository.updated_at * 1000).toLocaleString() : null); item.append(evidence);
      const newer = repository.deployment_evidence.find((run) => run.head_sha !== repository.blocking_sha && run.conclusion === "success");
      if (newer) text(item, "p", `Contradictory evidence: newer successful main deployment ${newer.head_sha.slice(0, 12)} is recorded but has not cleared this lock.`).className = "warning";
      const button = text(item, "button", "Revalidate"); button.type = "button"; button.addEventListener("click", () => openRevalidate(repository));
    }
    repositoryCards.append(item);
  }
}

async function refreshRepositories() {
  try { renderRepositories(await api("/api/repositories")); }
  catch { repositoryCards.setAttribute("aria-busy", "false"); repositoryCards.innerHTML = '<p class="error">Repository health is unavailable. No state was inferred.</p>'; }
}

function openRevalidate(repository) {
  selectedRepository = repository;
  document.querySelector("#revalidate-transition").textContent = `${repository.repository} will transition from ${repository.state} to healthy only if GitHub evidence satisfies ${repository.evidence_policy.replaceAll("_", " ")}.`;
  document.querySelector("#revalidate-evidence").innerHTML = `<div><dt>Blocking SHA</dt><dd>${repository.blocking_sha}</dd></div><div><dt>Observed version</dt><dd>${repository.updated_at}</dd></div>`;
  revalidateDialog.showModal(); revalidateForm.elements.reason.focus();
}
document.querySelector("#cancel-revalidate").addEventListener("click", () => revalidateDialog.close());
revalidateForm.addEventListener("submit", async (event) => {
  event.preventDefault(); const submit = revalidateForm.querySelector('[type="submit"]'); submit.disabled = true;
  try {
    const result = await api("/api/repositories/revalidate", { method: "POST", headers: { "content-type": "application/json", "Idempotency-Key": crypto.randomUUID() }, body: JSON.stringify({ repository: selectedRepository.repository, expected_updated_at: selectedRepository.updated_at, confirmation: "REVALIDATE_RECOVERY", reason: new FormData(revalidateForm).get("reason"), request_id: crypto.randomUUID() }) });
    announcement.textContent = result.repaired ? "Recovery lock repaired and Ready work reconsidered." : result.message; revalidateForm.reset(); revalidateDialog.close(); await refreshRepositories();
  } catch (error) { announcement.textContent = `Revalidation failed: ${error.message}`; document.querySelector("#revalidate-transition").textContent = `${error.message}. The recovery lock was retained; refresh and inspect the evidence before retrying.`; }
  finally { submit.disabled = false; }
});
refreshRepositories();
