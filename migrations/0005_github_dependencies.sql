CREATE TABLE github_dependencies (
  dependent_key TEXT NOT NULL,
  dependent_node_id TEXT NOT NULL,
  prerequisite_key TEXT NOT NULL,
  prerequisite_node_id TEXT NOT NULL,
  prerequisite_state TEXT NOT NULL,
  prerequisite_state_reason TEXT,
  relationship_identity TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  reconciliation_status TEXT NOT NULL,
  PRIMARY KEY (dependent_node_id, prerequisite_node_id)
);

CREATE INDEX github_dependencies_prerequisite_idx ON github_dependencies(prerequisite_node_id);

CREATE TABLE dependency_events (
  fingerprint TEXT PRIMARY KEY,
  task_id TEXT,
  kind TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
