ALTER TABLE tasks ADD COLUMN pull_request_number INTEGER;
ALTER TABLE tasks ADD COLUMN merge_sha TEXT;
ALTER TABLE tasks ADD COLUMN is_recovery INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN recovery_for_sha TEXT;

CREATE TABLE repository_health (
  repository TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('healthy','deploying','recovery','recovery_blocked')),
  blocking_sha TEXT,
  workflow_url TEXT,
  root_task_id TEXT REFERENCES tasks(id),
  recovery_attempts INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

CREATE TABLE deployment_runs (
  repository TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  workflow_name TEXT NOT NULL,
  conclusion TEXT NOT NULL,
  workflow_url TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(repository, head_sha, workflow_name)
);

CREATE UNIQUE INDEX tasks_recovery_sha_idx
  ON tasks(repository, recovery_for_sha)
  WHERE recovery_for_sha IS NOT NULL;
