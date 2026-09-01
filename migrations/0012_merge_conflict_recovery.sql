CREATE TABLE merge_conflict_recoveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tuple_key TEXT NOT NULL UNIQUE,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  repository TEXT NOT NULL,
  issue_number INTEGER NOT NULL,
  pull_request_number INTEGER NOT NULL,
  base_sha TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('mergeability_unknown','conflicting','correction_dispatched','corrected','correction_failed','superseded')),
  dispatch_identity TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  failure_evidence TEXT,
  dispatched_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX merge_conflict_recoveries_task_idx ON merge_conflict_recoveries(task_id, state, updated_at);
