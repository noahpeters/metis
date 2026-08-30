export const STATE_LABELS = [
  "metis:ready",
  "metis:planning",
  "metis:implementing",
  "metis:reviewing",
  "metis:blocked",
  "metis:budget-blocked",
  "metis:pr-ready",
  "metis:failed",
];

export const TRANSITIONS = {
  "metis:ready": ["metis:planning", "metis:budget-blocked"],
  "metis:planning": ["metis:implementing", "metis:blocked", "metis:failed"],
  "metis:implementing": ["metis:reviewing", "metis:blocked", "metis:failed"],
  "metis:reviewing": ["metis:implementing", "metis:pr-ready", "metis:blocked", "metis:failed"],
  "metis:blocked": ["metis:ready"],
  "metis:budget-blocked": ["metis:ready"],
  "metis:failed": ["metis:ready"],
  "metis:pr-ready": [],
};

export function assertTransition(from, to) {
  if (!TRANSITIONS[from]?.includes(to)) {
    throw new Error(`Invalid Metis transition: ${from} -> ${to}`);
  }
}

export function replaceState(labels, nextState) {
  if (!STATE_LABELS.includes(nextState)) throw new Error(`Unknown Metis state: ${nextState}`);
  return [...labels.filter((label) => !STATE_LABELS.includes(label)), nextState];
}
