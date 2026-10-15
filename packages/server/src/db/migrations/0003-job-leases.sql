-- One worker per attempt (M14c A5): the token that leased a job is marked, and revoked tokens are
-- kept (only their hashes) so the sweeper can count how often an attempt was started.
ALTER TABLE job_tokens ADD COLUMN leased boolean NOT NULL DEFAULT false;
ALTER TABLE job_tokens ADD COLUMN revoked boolean NOT NULL DEFAULT false;
