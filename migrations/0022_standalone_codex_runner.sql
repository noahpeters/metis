-- Separate opt-in execution mode; existing proof tasks retain their behavior.
ALTER TABLE standalone_tasks ADD COLUMN executor TEXT NOT NULL DEFAULT 'proof';
ALTER TABLE standalone_tasks ADD COLUMN verification TEXT;
