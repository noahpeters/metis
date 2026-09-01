ALTER TABLE webhook_deliveries ADD COLUMN state TEXT NOT NULL DEFAULT 'received' CHECK(state IN ('received','queued','processing','completed','failed'));
ALTER TABLE webhook_deliveries ADD COLUMN payload_json TEXT;
ALTER TABLE webhook_deliveries ADD COLUMN updated_at INTEGER;
ALTER TABLE webhook_deliveries ADD COLUMN error TEXT;

CREATE TABLE reconciliation_events (
  event_key TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  transition TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  error TEXT,
  reported_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX reconciliation_events_task_idx ON reconciliation_events(task_id, created_at);
