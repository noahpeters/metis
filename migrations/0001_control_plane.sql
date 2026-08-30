CREATE TABLE webhook_deliveries (
  delivery_id TEXT PRIMARY KEY,
  event_name TEXT NOT NULL,
  received_at INTEGER NOT NULL
);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  repository TEXT NOT NULL,
  issue_number INTEGER NOT NULL,
  issue_node_id TEXT,
  title TEXT NOT NULL,
  body TEXT,
  summary TEXT,
  state TEXT NOT NULL,
  actor TEXT,
  size_class TEXT CHECK (size_class IN ('small','medium','large','unknown')),
  size_confidence REAL,
  estimated_cost_units INTEGER,
  max_cost_units INTEGER,
  budget_approved INTEGER NOT NULL DEFAULT 0,
  priority_score INTEGER,
  dependencies_json TEXT NOT NULL DEFAULT '[]',
  blocker_reason TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  pull_request_url TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(repository, issue_number)
);

CREATE INDEX tasks_scheduler_idx ON tasks(state, priority_score DESC, created_at);

CREATE TABLE task_leases (
  task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  lease_id TEXT NOT NULL UNIQUE,
  provider TEXT NOT NULL,
  cost_units_reserved INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE dispatches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  lease_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  external_id TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL,
  result_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE provider_capacity (
  provider TEXT PRIMARY KEY,
  role TEXT NOT NULL,
  available INTEGER NOT NULL DEFAULT 1,
  remaining_units INTEGER,
  resets_at INTEGER,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  updated_at INTEGER NOT NULL
);

INSERT INTO provider_capacity(provider, role, available, remaining_units, updated_at) VALUES
  ('workers_ai', 'orchestration', 1, NULL, unixepoch()),
  ('codex_included', 'coding', 1, 20, unixepoch()),
  ('perplexity', 'research_only', 0, 0, unixepoch()),
  ('paid_api', 'fallback_disabled', 0, 0, unixepoch());

CREATE TABLE budget_windows (
  window_key TEXT PRIMARY KEY,
  cost_units_used INTEGER NOT NULL DEFAULT 0,
  tasks_started INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE usage_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT REFERENCES tasks(id),
  provider TEXT NOT NULL,
  operation TEXT NOT NULL,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cost_units INTEGER NOT NULL DEFAULT 0,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);

CREATE TABLE dependencies (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  dependency_ref TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'unverified',
  PRIMARY KEY(task_id, dependency_ref)
);
