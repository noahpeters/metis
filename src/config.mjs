export const TASK_SIZES = ["small", "medium", "large", "unknown"];

export const DEFAULT_POLICY = Object.freeze({
  global: {
    maxConcurrentTasks: 2,
    maxCostUnitsPerWindow: 20,
    maxTasksPerWindow: 4,
    maxRetries: 2,
    leaseSeconds: 3600,
  },
  taskSizes: {
    small: { estimatedCostUnits: 2, maxCostUnits: 4, dispatch: "automatic" },
    medium: { estimatedCostUnits: 5, maxCostUnits: 8, dispatch: "automatic" },
    large: { estimatedCostUnits: 12, maxCostUnits: 16, dispatch: "approval_required" },
    unknown: { estimatedCostUnits: 8, maxCostUnits: 8, dispatch: "approval_required" },
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
  return {
    global: { ...DEFAULT_POLICY.global, ...supplied.global },
    taskSizes: Object.fromEntries(TASK_SIZES.map((size) => [
      size,
      { ...DEFAULT_POLICY.taskSizes[size], ...supplied.taskSizes?.[size] },
    ])),
    providers: Object.fromEntries(Object.entries(DEFAULT_POLICY.providers).map(([name, value]) => [
      name,
      { ...value, ...supplied.providers?.[name] },
    ])),
  };
}

export function taskBudget(policy, size, override) {
  const selected = policy.taskSizes[TASK_SIZES.includes(size) ? size : "unknown"];
  return override == null ? selected.maxCostUnits : Math.min(override, selected.maxCostUnits);
}
