-- Additive: retain artifact_key for future optional external artifacts.
ALTER TABLE standalone_tasks ADD COLUMN result_json TEXT;
ALTER TABLE standalone_tasks ADD COLUMN execution_started_at INTEGER;
ALTER TABLE standalone_tasks ADD COLUMN claim_token TEXT;
CREATE TABLE standalone_task_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES standalone_tasks(id),
  state TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX standalone_task_events_task ON standalone_task_events(task_id,sequence);
CREATE TRIGGER standalone_task_created AFTER INSERT ON standalone_tasks
BEGIN
  INSERT INTO standalone_task_events(task_id,state) VALUES (NEW.id,NEW.state);
END;
CREATE TRIGGER standalone_task_state_changed AFTER UPDATE OF state ON standalone_tasks
WHEN OLD.state <> NEW.state
BEGIN
  INSERT INTO standalone_task_events(task_id,state) VALUES (NEW.id,NEW.state);
END;
