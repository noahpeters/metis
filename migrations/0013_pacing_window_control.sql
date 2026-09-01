-- Logical pacing generations make an operator reset independent of the civil-day key.
ALTER TABLE pacing_windows ADD COLUMN started_at INTEGER;
ALTER TABLE pacing_windows ADD COLUMN ended_at INTEGER;
ALTER TABLE pacing_windows ADD COLUMN superseded_by TEXT;

UPDATE pacing_windows SET started_at = unixepoch(window_key || 'T00:00:00Z') WHERE started_at IS NULL;

CREATE TABLE pacing_window_control (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  current_window_id TEXT NOT NULL UNIQUE REFERENCES pacing_windows(window_key),
  generation INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

INSERT INTO pacing_windows(window_key,estimated_workload_units_used,tasks_started,started_at)
  VALUES(date('now'),0,0,unixepoch(date('now'))) ON CONFLICT(window_key) DO NOTHING;
INSERT INTO pacing_window_control(singleton,current_window_id,generation,updated_at)
  VALUES(1,date('now'),0,unixepoch());

CREATE TABLE pacing_reset_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT NOT NULL UNIQUE,
  idempotency_key TEXT NOT NULL UNIQUE,
  actor_email TEXT NOT NULL,
  source_window_id TEXT NOT NULL,
  new_window_id TEXT NOT NULL UNIQUE,
  reason TEXT NOT NULL,
  deployment_version TEXT,
  outcome TEXT NOT NULL CHECK(outcome = 'reset'),
  created_at INTEGER NOT NULL
);

