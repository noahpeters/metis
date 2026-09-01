CREATE TABLE provider_observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  workspace_ref TEXT,
  provider_ref TEXT,
  event_class TEXT NOT NULL,
  classification TEXT NOT NULL CHECK (classification IN ('actual','estimated','unattributed','stale','unavailable','unknown')),
  observed_at INTEGER NOT NULL,
  provider_window_start INTEGER,
  provider_window_end INTEGER,
  provider_timezone TEXT,
  freshness TEXT NOT NULL CHECK (freshness IN ('fresh','stale','unknown')),
  sanitized_status TEXT,
  input_tokens REAL,
  output_tokens REAL,
  total_tokens REAL,
  credits REAL,
  model TEXT,
  reset_at INTEGER,
  execution_surface TEXT,
  task_id TEXT REFERENCES tasks(id),
  repository TEXT,
  issue_number INTEGER,
  pull_request_number INTEGER,
  dispatch_id INTEGER REFERENCES dispatches(id),
  lease_id TEXT,
  deduplication_key TEXT NOT NULL,
  source_revision TEXT NOT NULL,
  pagination_checkpoint TEXT,
  reconciliation_state TEXT NOT NULL CHECK (reconciliation_state IN ('pending','reconciled','superseded','conflict')),
  derived_metrics_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  UNIQUE(provider, workspace_ref, deduplication_key, source_revision)
);

CREATE UNIQUE INDEX provider_observations_global_dedup_idx
  ON provider_observations(provider, deduplication_key, source_revision)
  WHERE workspace_ref IS NULL;

CREATE INDEX provider_observations_reconcile_idx
  ON provider_observations(provider, workspace_ref, reconciliation_state, observed_at);
