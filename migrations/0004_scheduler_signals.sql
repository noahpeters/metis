CREATE TABLE scheduler_signals (
  signal_key TEXT PRIMARY KEY,
  window_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
