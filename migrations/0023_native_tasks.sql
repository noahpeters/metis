-- Native tasks are independent of GitHub issue orchestration. Executions reuse
-- the existing standalone ledger and its durable runtime identity.
CREATE TABLE native_tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  instructions TEXT NOT NULL,
  data_json TEXT NOT NULL DEFAULT '{}',
  phase TEXT NOT NULL DEFAULT 'draft' CHECK(phase IN ('draft','ready','cancelled')),
  version INTEGER NOT NULL DEFAULT 1,
  mutation_token TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE TABLE native_task_dependencies (
  task_id TEXT NOT NULL REFERENCES native_tasks(id),
  dependency_id TEXT NOT NULL REFERENCES native_tasks(id),
  PRIMARY KEY(task_id,dependency_id),
  CHECK(task_id<>dependency_id)
);
CREATE TABLE native_task_attempts (
  id TEXT PRIMARY KEY REFERENCES standalone_tasks(id),
  task_id TEXT NOT NULL REFERENCES native_tasks(id),
  requested_by TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  sent_at INTEGER
);
CREATE INDEX native_attempt_task ON native_task_attempts(task_id,created_at,id);
CREATE INDEX native_dependency_target ON native_task_dependencies(dependency_id);
