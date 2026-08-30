CREATE TABLE revision_dispatches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  pull_request_number INTEGER NOT NULL,
  base_head_sha TEXT NOT NULL,
  lease_id TEXT NOT NULL UNIQUE,
  external_id TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL,
  feedback_json TEXT NOT NULL,
  result_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(task_id, base_head_sha)
);

CREATE INDEX revision_dispatches_active_idx ON revision_dispatches(task_id, state, created_at);
