const known = (value) => value !== null && value !== undefined;
const display = (value) => known(value) ? String(value) : "unknown";

export function derivePacingView(overview) {
  const workload = overview?.pacing?.estimated_workload_units || {};
  const starts = overview?.pacing?.task_starts || {};
  const active = overview?.active_tasks?.count;
  const ready = overview?.executable_ready?.count;
  const dimension = overview?.pacing?.limiting_dimension;
  const base = { used: display(workload.used), limit: display(workload.limit), startsUsed: display(starts.used), startsLimit: display(starts.limit), warning: false, nudgeAllowed: false };
  if (!overview || overview.semantics !== "estimated_local_pacing" || !known(active) || overview.pacing?.state === "unknown") {
    return { ...base, tone: "unknown", label: "Status unknown", reason: "The local pacing observation is incomplete or unknown." };
  }
  if (active > 0) return { ...base, tone: "active", label: "Actively implementing", reason: `${active} ${active === 1 ? "task is" : "tasks are"} in an active execution state.` };
  if (overview.pacing.state === "exhausted") {
    const named = dimension === "task_starts" ? "Task-start limit exhausted" : dimension === "estimated_workload_units" ? "Workload-unit limit exhausted" : "Pacing exhausted";
    return { ...base, tone: "exhausted", label: named, reason: "No task is executing. Work can resume after the next scheduled reset." };
  }
  if (ready === 0) return { ...base, tone: "idle", label: "Available and idle", reason: "Pacing is available and no executable Ready work exists." };
  if (known(ready) && ready > 0) {
    const provider = overview.provider_capacity?.state;
    const reason = provider === "unavailable" ? "Provider capacity is unavailable." : provider === "unknown" ? "Provider capacity data is unknown." : "Dispatch is waiting on repository health, concurrency reconciliation, or a fresh control-plane observation.";
    return { ...base, tone: "waiting", label: "Ready work is waiting", nudgeAllowed: true, reason: `${ready} executable Ready ${ready === 1 ? "task exists" : "tasks exist"}. ${reason}`, warning: true };
  }
  return { ...base, tone: "unknown", label: "Status unknown", reason: "Executable-work freshness is unavailable; Metis cannot verify that it is idle." };
}

export function formatExactTime(timestamp) {
  if (!timestamp || !Number.isFinite(Date.parse(timestamp))) return "unknown time";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "long", timeZone: "UTC" }).format(new Date(timestamp));
}

export function relativeUntil(timestamp, now = Date.now()) {
  const milliseconds = Date.parse(timestamp);
  if (!Number.isFinite(milliseconds)) return "timing unknown";
  const seconds = Math.round((milliseconds - now) / 1000);
  const absolute = Math.abs(seconds);
  const [divisor, unit] = absolute >= 86400 ? [86400, "day"] : absolute >= 3600 ? [3600, "hour"] : absolute >= 60 ? [60, "minute"] : [1, "second"];
  return new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(Math.round(seconds / divisor), unit);
}
