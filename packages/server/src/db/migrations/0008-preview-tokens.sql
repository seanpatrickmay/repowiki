-- ADR-0012: previews open on the pages origin through short-lived capability URLs. Only each
-- token's SHA-256 is stored, with the revision it opens and when it stops working.
CREATE TABLE preview_tokens (
  token_hash text PRIMARY KEY,
  project_id uuid NOT NULL,
  revision int NOT NULL,
  expires_at timestamptz NOT NULL
);

CREATE INDEX preview_tokens_expiry ON preview_tokens (expires_at);
