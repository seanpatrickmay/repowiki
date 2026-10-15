-- Real spend (M14c fresh review): a reservation keeps the uncapped actual cost and when it was
-- settled, so budgets count spend past a job's cap and by the day it happened; `batch` marks a
-- batch create's reservation, so a job's batches in flight can be counted.
ALTER TABLE reservations
  ADD COLUMN actual_usd_micros bigint,
  ADD COLUMN settled_at timestamptz,
  ADD COLUMN batch boolean NOT NULL DEFAULT false;
