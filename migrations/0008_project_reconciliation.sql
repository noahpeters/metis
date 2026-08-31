CREATE TABLE project_reconciliation_runs (
  id TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('running','succeeded','failed')),
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  pages_read INTEGER NOT NULL DEFAULT 0,
  items_observed INTEGER NOT NULL DEFAULT 0,
  items_admitted INTEGER NOT NULL DEFAULT 0,
  last_cursor TEXT,
  failure_kind TEXT,
  failure_reason TEXT
);

CREATE INDEX project_reconciliation_runs_started_idx
  ON project_reconciliation_runs(started_at DESC);

CREATE TABLE project_reconciliation_checkpoint (
  project_id TEXT PRIMARY KEY,
  last_successful_run_id TEXT REFERENCES project_reconciliation_runs(id),
  last_successful_at INTEGER,
  last_cursor TEXT,
  updated_at INTEGER NOT NULL
);

-- A signal exists only while its queue message is outstanding. This prevents
-- repeated polling from producing duplicate intake/dispatch messages.
CREATE TABLE project_queue_signals (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  message_type TEXT NOT NULL CHECK (message_type IN ('intake','dispatch')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY(task_id, message_type)
);
