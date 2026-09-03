CREATE TABLE issue_admin_audit (
  request_id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  task_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('reset_ready','force_complete')),
  actor_email TEXT NOT NULL,
  reason TEXT NOT NULL,
  diff_reference TEXT,
  before_json TEXT NOT NULL,
  after_json TEXT NOT NULL,
  deployment_version TEXT,
  created_at INTEGER NOT NULL
);
