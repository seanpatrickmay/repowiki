-- At most one active handle per account (Contract §9), and an index for sweeping expired sessions.
CREATE UNIQUE INDEX handles_one_active ON handles (account_id) WHERE body->>'state' = 'active';
CREATE INDEX sessions_expires ON sessions (expires_at);
