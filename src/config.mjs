export const TASK_SIZES = ["small", "medium", "large", "unknown"];

export const DEFAULT_POLICY = Object.freeze({
  global: {
    maxConcurrentTasks: 2,
    maxEstimatedWorkloadUnitsPerWindow: 20,
    maxTasksPerWindow: 4,
    maxRetries: 2,
    leaseSeconds: 3600,
  },
  taskSizes: {
    small: { estimatedWorkloadUnits: 2, maxWorkloadUnits: 4, dispatch: "automatic" },
    medium: { estimatedWorkloadUnits: 5, maxWorkloadUnits: 8, dispatch: "automatic" },
    large: { estimatedWorkloadUnits: 12, maxWorkloadUnits: 16, dispatch: "approval_required" },
    unknown: { estimatedWorkloadUnits: 8, maxWorkloadUnits: 8, dispatch: "approval_required" },
  },
  providers: {
    workers_ai: { enabled: true, role: "orchestration", priority: 1 },
    codex_included: { enabled: true, role: "coding", priority: 1 },
    perplexity: { enabled: false, role: "research_only", priority: 10 },
    paid_api: { enabled: false, role: "fallback", priority: 99 },
  },
});

export function loadPolicy(raw) {
  if (!raw) return structuredClone(DEFAULT_POLICY);
  const supplied = typeof raw === "string" ? JSON.parse(raw) : raw;
  const global = { ...supplied.global };
  if (global.maxEstimatedWorkloadUnitsPerWindow == null && global.maxCostUnitsPerWindow != null) {
    global.maxEstimatedWorkloadUnitsPerWindow = global.maxCostUnitsPerWindow;
  }
  delete global.maxCostUnitsPerWindow;
  return {
    global: { ...DEFAULT_POLICY.global, ...global },
    taskSizes: Object.fromEntries(TASK_SIZES.map((size) => [
      size,
      { ...DEFAULT_POLICY.taskSizes[size], ...legacyTaskSizePolicy(supplied.taskSizes?.[size]) },
    ])),
    providers: Object.fromEntries(Object.entries(DEFAULT_POLICY.providers).map(([name, value]) => [
      name,
      { ...value, ...supplied.providers?.[name] },
    ])),
  };
}

export function taskWorkloadLimit(policy, size, override) {
  const selected = policy.taskSizes[TASK_SIZES.includes(size) ? size : "unknown"];
  return override == null ? selected.maxWorkloadUnits : Math.min(override, selected.maxWorkloadUnits);
}

function legacyTaskSizePolicy(value = {}) {
  const normalized = { ...value };
  if (normalized.estimatedWorkloadUnits == null && normalized.estimatedCostUnits != null) normalized.estimatedWorkloadUnits = normalized.estimatedCostUnits;
  if (normalized.maxWorkloadUnits == null && normalized.maxCostUnits != null) normalized.maxWorkloadUnits = normalized.maxCostUnits;
  delete normalized.estimatedCostUnits;
  delete normalized.maxCostUnits;
  return normalized;
}
