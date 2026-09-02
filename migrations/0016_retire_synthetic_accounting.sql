-- Workload values are planning estimates retained only for historical audit.
-- Renames make compatibility data impossible to mistake for provider usage.
ALTER TABLE task_leases RENAME COLUMN estimated_workload_units_reserved TO legacy_estimated_workload_units_reserved;
ALTER TABLE dispatch_reservations RENAME COLUMN workload_units TO legacy_estimated_workload_units;

-- Provider-reported capacity has no unit balance contract. Preserve the old
-- column for rollback/forensics, but cut it over to explicitly unknown.
UPDATE provider_capacity SET legacy_estimated_workload_units = NULL;

-- Older workers could observe completion as the first authoritative acceptance
-- signal and release the lease while leaving the reservation marked reserved.
-- Promote those correlated rows before checking the cutover invariant.
UPDATE dispatch_reservations SET state='committed',reason_class='legacy_cutover_accepted',updated_at=unixepoch()
WHERE state='reserved' AND EXISTS (
  SELECT 1 FROM dispatches d WHERE d.lease_id=dispatch_reservations.lease_id
  AND d.state IN ('running','awaiting_pr_creation','completed')
);
INSERT INTO reservation_adjustments(lease_id,operation,task_id,reason_class,created_at)
SELECT lease_id,'commit',task_id,'legacy_cutover_accepted',unixepoch()
FROM dispatch_reservations WHERE state='committed' AND reason_class='legacy_cutover_accepted'
ON CONFLICT(lease_id,operation) DO NOTHING;

-- This insert is the atomic cutover check. It fails the migration if an active
-- reservation has lost its operational lease; released/committed history does
-- not require a lease and remains linked through dispatch_reservations.
CREATE TABLE synthetic_accounting_cutover (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  cutover_version INTEGER NOT NULL CHECK(cutover_version = 1),
  checked_at INTEGER NOT NULL,
  active_reservations_checked INTEGER NOT NULL CHECK(active_reservations_checked >= 0)
);
CREATE TRIGGER synthetic_accounting_cutover_guard
BEFORE INSERT ON synthetic_accounting_cutover
WHEN EXISTS (
  SELECT 1 FROM dispatch_reservations r
  LEFT JOIN task_leases l ON l.lease_id = r.lease_id
  WHERE r.state IN ('reserved','reconciliation_required') AND l.lease_id IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'synthetic accounting cutover: active reservation is missing its lease');
END;
INSERT INTO synthetic_accounting_cutover(singleton,cutover_version,checked_at,active_reservations_checked)
SELECT 1,1,unixepoch(),COUNT(*) FROM dispatch_reservations
WHERE state IN ('reserved','reconciliation_required');
DROP TRIGGER synthetic_accounting_cutover_guard;
