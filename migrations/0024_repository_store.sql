CREATE TABLE repository_objects (ref TEXT PRIMARY KEY, sha256 TEXT NOT NULL, chunks INTEGER NOT NULL, created_at INTEGER NOT NULL DEFAULT(unixepoch()));
CREATE TABLE repository_object_chunks (ref TEXT NOT NULL REFERENCES repository_objects(ref), sequence INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(ref,sequence));
CREATE TABLE repository_records (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL DEFAULT(unixepoch()));
CREATE TABLE repository_locks (change_id TEXT PRIMARY KEY, owner TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL DEFAULT(unixepoch()));

ALTER TABLE native_task_attempts ADD COLUMN rework_reason TEXT;
CREATE TABLE repository_publication_jobs (id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL REFERENCES native_task_attempts(id), state TEXT NOT NULL DEFAULT 'queued', mode TEXT NOT NULL DEFAULT 'publish', created_at INTEGER NOT NULL DEFAULT(unixepoch()));
CREATE UNIQUE INDEX repository_publication_active ON repository_publication_jobs(attempt_id) WHERE state IN ('queued','running');
