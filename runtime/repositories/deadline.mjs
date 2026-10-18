// Opt-in per binding. Keep the longest request below the existing 20-minute
// repository lease and 30-minute capability lifetime. Reserve time for
// startup/shutdown within the Queue consumer's 15-minute wall-clock limit.
export function repositoryExecutionTimeoutMs(config) {
  return Number.isInteger(config?.executionTimeoutMs)
    ? Math.max(1000,Math.min(config.executionTimeoutMs,600000)) : 90000;
}
export function repositoryRequestTimeoutMs(config) {
  return Math.max(600000,repositoryExecutionTimeoutMs(config)+180000);
}
export function repositorySleepAfter(config) {
  return `${Math.ceil(repositoryRequestTimeoutMs(config)/60000)+2}m`;
}
