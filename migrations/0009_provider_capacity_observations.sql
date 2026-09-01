CREATE TABLE provider_capacity_observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  dispatch_id INTEGER NOT NULL REFERENCES dispatches(id) ON DELETE CASCADE,
  evidence_key TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('accepted','rejected','exhausted','unavailable','unknown')),
  observed_at INTEGER NOT NULL,
  reset_at INTEGER,
  limit_reason TEXT,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  UNIQUE(provider, evidence_key)
);

CREATE INDEX provider_capacity_observations_dispatch_idx
  ON provider_capacity_observations(dispatch_id, observed_at DESC);
