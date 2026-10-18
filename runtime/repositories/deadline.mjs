// Ordinary bindings stay within the Queue consumer's 15-minute wall-clock
// limit. Read-only diagnostics use private RPC, never queued admission.
export function repositoryExecutionTimeoutMs(config) {
  return Number.isInteger(config?.executionTimeoutMs)
    ? Math.max(1000,Math.min(config.executionTimeoutMs,config.readOnlyDiagnostic===true?2100000:600000)) : 90000;
}
export const repositoryLeaseSeconds=config=>config?.readOnlyDiagnostic===true?2700:1200;
export const repositoryCapabilitySeconds=config=>config?.readOnlyDiagnostic===true?3000:1800;
export function repositoryRequestTimeoutMs(config) {
  return Math.max(600000,repositoryExecutionTimeoutMs(config)+180000);
}
export function repositorySleepAfter(config) {
  return `${Math.ceil(repositoryRequestTimeoutMs(config)/60000)+2}m`;
}
