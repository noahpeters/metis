CREATE TABLE project_status_sync (
  task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  status_name TEXT NOT NULL,
  last_error TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

-- A transition commits first; this durable marker is created in the same D1
-- transaction and is consumed independently by Project reconciliation.
CREATE TRIGGER tasks_project_status_insert AFTER INSERT ON tasks
BEGIN
  INSERT INTO project_status_sync(task_id,status_name,updated_at)
  VALUES(new.id,new.state,unixepoch())
  ON CONFLICT(task_id) DO UPDATE SET status_name=excluded.status_name,updated_at=unixepoch();
END;

CREATE TRIGGER tasks_project_status_update AFTER UPDATE OF state ON tasks
WHEN old.state <> new.state
BEGIN
  INSERT INTO project_status_sync(task_id,status_name,updated_at)
  VALUES(new.id,new.state,unixepoch())
  ON CONFLICT(task_id) DO UPDATE SET status_name=excluded.status_name,last_error=NULL,updated_at=unixepoch();
END;
