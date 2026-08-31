-- These columns contain Metis estimates, never provider-reported capacity or accounting.
ALTER TABLE tasks RENAME COLUMN estimated_cost_units TO estimated_workload_units;
ALTER TABLE tasks RENAME COLUMN max_cost_units TO max_workload_units;
ALTER TABLE task_leases RENAME COLUMN cost_units_reserved TO estimated_workload_units_reserved;
ALTER TABLE budget_windows RENAME TO pacing_windows;
ALTER TABLE pacing_windows RENAME COLUMN cost_units_used TO estimated_workload_units_used;
ALTER TABLE usage_events RENAME COLUMN cost_units TO legacy_estimated_workload_units;
ALTER TABLE provider_capacity RENAME COLUMN remaining_units TO legacy_estimated_workload_units;
