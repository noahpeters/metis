CREATE TABLE capacity_reenergizations (
  request_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN ('automatic','operator')),
  actor TEXT,
  source_observed_at INTEGER NOT NULL,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX capacity_reenergizations_provider_idx
  ON capacity_reenergizations(provider,created_at DESC);
