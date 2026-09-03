import { derivePacingView, formatExactTime } from "./pacing.js";

const card = document.querySelector("#pacing-card");
const announcement = document.querySelector("#announcement");
const repositoryCards = document.querySelector("#repository-cards");
const revalidateDialog = document.querySelector("#revalidate-dialog");
const revalidateForm = document.querySelector("#revalidate-form");
const issueActionDialog = document.querySelector("#issue-action-dialog");
const issueActionForm = document.querySelector("#issue-action-form");
const nudgeButton = document.querySelector("#nudge");
const reenergizeButton = document.querySelector("#reenergize");
const actions = document.querySelector("#pacing-actions");
let verifiedOverview = null;
const liveStatus = document.querySelector("#live-status");
let streamId = null;
let streamRevision = 0;
let staleTimer;

function setLiveState(state, label) {
  liveStatus.dataset.state = state;
  liveStatus.textContent = label;
}

function markFresh() {
  clearTimeout(staleTimer);
  setLiveState("live", "Live");
  staleTimer = setTimeout(() => {
    setLiveState("stale", "Stale");
    if (verifiedOverview) render(verifiedOverview, true, "Live updates are delayed; reconnecting automatically.");
  }, 5_000);
}
let selectedRepository = null;
let selectedIssue = null;
let selectedIssueAction = null;

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
  text(details, "p", "CODEX CAPACITY").className = "eyebrow";
  text(details, "h1", view.label);
  text(details, "p", view.reason).className = view.warning ? "reason warning" : "reason";
  if (view.expectedAvailableAt) {
    const expected = document.createElement("p"); expected.className = "reset-time";
    text(expected, "span", "Expected availability ");
    const time = text(expected, "time", formatExactTime(view.expectedAvailableAt)); time.dateTime = view.expectedAvailableAt;
    details.append(expected);
  }
  text(details, "p", "WORK COMPLETED · SIZE POINTS").className = "completion-label";
  const completion = document.createElement("dl"); completion.className = "completion-grid";
  for (const [label, value] of [["Last hour", view.completed1h], ["Last 8 hours", view.completed8h], ["Last 24 hours", view.completed24h]]) {
    const item = document.createElement("div"); text(item, "dt", label); text(item, "dd", value); completion.append(item);
  }
  details.append(completion);

  const meta = document.createElement("p");
  meta.className = "meta";
  meta.textContent = `${stale ? "Stale — last verified " : "Observed "}${formatExactTime(overview?.observed_at)} · Task starts ${view.startsUsed} / ${view.startsLimit}`;
  details.append(meta);
  if (error) text(details, "p", error).className = "error";
  details.append(actions);
  card.append(visual, details);
  nudgeButton.hidden = !view.nudgeAllowed;
  reenergizeButton.hidden = !view.reenergizeAllowed;
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
      card.innerHTML = '<div class="status-details"><p class="eyebrow">CODEX CAPACITY</p><h1>Status unknown</h1><p class="reason">No verified pacing observation is available.</p><button id="retry" type="button">Retry</button></div>';
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

reenergizeButton.addEventListener("click", async () => {
  reenergizeButton.disabled = true;
  reenergizeButton.textContent = "Reenergizing…";
  announcement.textContent = "Reenergizing capacity and reconsidering Ready work.";
  try {
    const result = await api("/api/capacity/reenergize", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirmation: "REENERGIZE_CAPACITY", request_id: crypto.randomUUID() }) });
    announcement.textContent = result.reconciliation_completed === false ? "Capacity reenergized, but Ready-work reconciliation did not complete and will retry on the next schedule." : "Capacity reenergized. Ready work was reconsidered.";
    await refresh();
  } catch (error) {
    announcement.textContent = `Reenergize failed: ${error.message}.`;
    await refresh();
  } finally {
    reenergizeButton.disabled = false;
    reenergizeButton.textContent = "Reenergize";
  }
});

function connect() {
  setLiveState(verifiedOverview ? "reconnecting" : "connecting", verifiedOverview ? "Reconnecting…" : "Connecting…");
  const events = new EventSource("/api/stream");
  events.addEventListener("snapshot", (event) => {
    const update = JSON.parse(event.data);
    if (update.stream_id === streamId && update.revision <= streamRevision) return;
    streamId = update.stream_id;
    streamRevision = update.revision;
    verifiedOverview = update.snapshot;
    render(verifiedOverview);
    markFresh();
  });
  events.addEventListener("unavailable", () => {
    setLiveState("stale", "Stale");
    if (verifiedOverview) render(verifiedOverview, true, "The control plane is temporarily unavailable; retrying automatically.");
    else refresh();
  });
  events.onerror = () => {
    setLiveState("reconnecting", "Reconnecting…");
    if (verifiedOverview) render(verifiedOverview, true, "Live updates disconnected; reconnecting automatically.");
    else refresh();
  };
}

connect();

function renderRepositories(overview) {
  repositoryCards.replaceChildren(); repositoryCards.setAttribute("aria-busy", "false");
  for (const repository of overview.repositories) {
    const item = document.createElement("article"); item.className = "repository-card"; item.dataset.health = repository.dispatch_locked ? "locked" : repository.ready_count > 0 ? "ready" : "idle";
    const heading = document.createElement("div"); heading.className = "repository-heading"; text(heading, "h3", repository.repository); text(heading, "span", repository.dispatch_locked ? "Recovery Locked" : repository.ready_count > 0 ? "Work ready" : "Backlog idle").className = "state-pill"; item.append(heading);
    const readySummary = repository.ready_count == null ? "Executable Ready count unavailable." : `${repository.ready_count} executable Ready issue${repository.ready_count === 1 ? "" : "s"}.`;
    text(item, "p", repository.dispatch_locked ? repository.waiting_reason : readySummary).className = "reason";
    if (!repository.dispatch_locked && repository.dependency_waiting_count > 0) text(item, "p", `${repository.dependency_waiting_count} additional Project Ready issue${repository.dependency_waiting_count === 1 ? " is" : "s are"} waiting on dependencies.`).className = "warning";
    if (!repository.project_counts) {
      text(item, "p", "Project status counts unavailable.").className = "project-counts-unavailable";
    } else {
      const counts = document.createElement("dl"); counts.className = "project-counts"; counts.setAttribute("aria-label", "Metis-owned Project issue counts");
      for (const [status, count] of Object.entries(repository.project_counts.statuses)) {
        const row = document.createElement("div"); text(row, "dt", status); text(row, "dd", String(count)); counts.append(row);
      }
      item.append(counts);
      const awaiting = repository.project_counts.statuses["Awaiting human"];
      if (awaiting) {
        const reasons = document.createElement("ul"); reasons.className = "awaiting-reasons"; reasons.setAttribute("aria-label", "Awaiting human reasons");
        for (const [reason, count] of Object.entries(repository.project_counts.awaiting_human_reasons)) text(reasons, "li", `${reason}: ${count}`);
        item.append(reasons);
      }
    }
    if (repository.dispatch_locked) {
      const evidence = document.createElement("dl"); evidence.className = "evidence-list";
      const add = (name, value, href) => { const row = document.createElement("div"); text(row, "dt", name); const dd = document.createElement("dd"); const node = text(dd, href ? "a" : "span", value || "Not observed"); if (href) { node.href = href; node.target = "_blank"; node.rel = "noreferrer"; } row.append(dd); evidence.append(row); };
      add("Blocking commit", repository.blocking_sha?.slice(0, 12), repository.workflow_url); add("Root task", repository.root_task_id); add("Recovery issue", repository.recovery_task ? `#${repository.recovery_task.issue_number} · ${repository.recovery_task.state}` : null); add("Recovery PR", repository.recovery_pr ? `#${repository.recovery_pr.number} · ${repository.recovery_pr.state.replaceAll("_", " ")}` : null, repository.recovery_pr?.url); add("Attempts", String(repository.recovery_attempts)); add("Evidence policy", repository.evidence_policy.replaceAll("_", " ")); add("Last transition", repository.updated_at ? new Date(repository.updated_at * 1000).toLocaleString() : null); item.append(evidence);
      const newer = repository.deployment_evidence.find((run) => run.head_sha !== repository.blocking_sha && run.conclusion === "success");
      if (newer) text(item, "p", `Contradictory evidence: newer successful main deployment ${newer.head_sha.slice(0, 12)} is recorded but has not cleared this lock.`).className = "warning";
      const button = text(item, "button", "Revalidate"); button.type = "button"; button.addEventListener("click", () => openRevalidate(repository));
    }
    if (repository.issues == null) text(item, "p", "Issue details unavailable.").className = "project-counts-unavailable";
    else if (repository.issues.length) {
      const issues = document.createElement("ul"); issues.className = "issue-list"; issues.setAttribute("aria-label", `${repository.repository} issues`);
      for (const issue of repository.issues) {
        const row = document.createElement("li");
        const details = document.createElement("div"); details.className = "issue-details";
        const link = text(details, "a", `#${issue.issue_number} ${issue.title}`); link.href = `https://github.com/${issue.repository}/issues/${issue.issue_number}`; link.target = "_blank"; link.rel = "noreferrer";
        const tags = document.createElement("div"); tags.className = "issue-tags"; text(tags, "span", issue.project_status || "Status unknown").className = "project-status-tag";
        for (const tag of issue.status_tags) text(tags, "span", tag.replace("metis:", "")).className = "lifecycle-tag";
        details.append(tags); row.append(details);
        const menu = document.createElement("details"); menu.className = "issue-menu";
        const trigger = document.createElement("summary"); trigger.setAttribute("aria-label", `Actions for issue ${issue.issue_number}`); trigger.textContent = "⋯"; menu.append(trigger);
        const options = document.createElement("div"); options.className = "issue-menu-options";
        for (const [action, label] of [["reset_ready", "Reset to Ready"], ["force_complete", "Force Complete"]]) { const button = text(options, "button", label); button.type = "button"; button.disabled = !issue.updated_at; button.addEventListener("click", () => openIssueAction(issue, action)); }
        menu.append(options); row.append(menu); issues.append(row);
      }
      item.append(issues);
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

function openIssueAction(issue, action) {
  selectedIssue = issue; selectedIssueAction = action;
  const force = action === "force_complete";
  document.querySelector("#issue-action-title").textContent = force ? `Force complete #${issue.issue_number}?` : `Reset #${issue.issue_number} to Ready?`;
  document.querySelector("#issue-action-summary").textContent = issue.title;
  document.querySelector("#issue-action-warning").textContent = force ? "This closes the GitHub issue and marks it Done without requiring a PR or verified deployment. Provide the code diff used to justify the decision." : "This supersedes active processing, releases stale leases, clears transient state, and allows Metis to start the issue again. Audit history is retained.";
  const diff = document.querySelector("#diff-reference"); const diffLabel = document.querySelector("#diff-reference-label"); diff.hidden = diffLabel.hidden = !force; diff.required = force;
  document.querySelector("#confirm-issue-action").textContent = force ? "Force Complete" : "Reset to Ready";
  issueActionDialog.showModal(); issueActionForm.elements[force ? "diff_reference" : "reason"].focus();
}
document.querySelector("#cancel-issue-action").addEventListener("click", () => issueActionDialog.close());
issueActionForm.addEventListener("submit", async (event) => {
  event.preventDefault(); const submit = document.querySelector("#confirm-issue-action"); submit.disabled = true;
  const force = selectedIssueAction === "force_complete"; const data = new FormData(issueActionForm);
  try {
    await api(force ? "/api/issues/force-complete" : "/api/issues/reset-ready", { method: "POST", headers: { "content-type": "application/json", "Idempotency-Key": crypto.randomUUID() }, body: JSON.stringify({ repository: selectedIssue.repository, issue_number: selectedIssue.issue_number, expected_updated_at: selectedIssue.updated_at, confirmation: force ? "FORCE_COMPLETE" : "RESET_TO_READY", reason: data.get("reason"), diff_reference: force ? data.get("diff_reference") : undefined, request_id: crypto.randomUUID() }) });
    announcement.textContent = force ? `Issue #${selectedIssue.issue_number} was force completed with deployment verification waived.` : `Issue #${selectedIssue.issue_number} was reset and Ready work was reconsidered.`;
    issueActionForm.reset(); issueActionDialog.close(); await refreshRepositories();
  } catch (error) { announcement.textContent = `Issue action failed: ${error.message}`; document.querySelector("#issue-action-warning").textContent = `${error.message}. Refresh before retrying; no success is assumed.`; }
  finally { submit.disabled = false; }
});
