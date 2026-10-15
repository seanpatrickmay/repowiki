-- Hosted RepoWiki, spec 2 §5. Every table keeps its Contract entity in `body`; the other columns
-- exist for keys, lookups and constraints. A shipped migration is never edited; append one.

CREATE TABLE accounts (
  id uuid PRIMARY KEY,
  github_user_id bigint NOT NULL UNIQUE,
  body jsonb NOT NULL
);

CREATE TABLE handles (
  handle text PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts (id),
  body jsonb NOT NULL
);
CREATE INDEX handles_account ON handles (account_id);

CREATE TABLE sessions (
  id_hash text PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts (id),
  csrf text NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX sessions_account ON sessions (account_id);

CREATE TABLE github_tokens (
  account_id uuid PRIMARY KEY REFERENCES accounts (id),
  ciphertext bytea NOT NULL,
  nonce bytea NOT NULL
);

CREATE TABLE repositories (
  github_repo_id bigint PRIMARY KEY,
  body jsonb NOT NULL
);

CREATE TABLE projects (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts (id),
  github_repo_id bigint NOT NULL,
  slug text NOT NULL,
  body jsonb NOT NULL,
  UNIQUE (account_id, github_repo_id),
  UNIQUE (account_id, slug)
);

CREATE TABLE jobs (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL,
  status text NOT NULL,
  lease_expires_at timestamptz,
  body jsonb NOT NULL
);
CREATE UNIQUE INDEX jobs_one_active ON jobs (project_id) WHERE status IN ('queued', 'running');
CREATE INDEX jobs_project ON jobs (project_id);

CREATE TABLE job_tokens (
  token_hash text PRIMARY KEY,
  job_id uuid NOT NULL,
  attempt int NOT NULL,
  issued_at timestamptz NOT NULL
);
CREATE INDEX job_tokens_job ON job_tokens (job_id);

-- What a worker needs that the Contract's Job does not hold: repository, author commits, export.
CREATE TABLE job_specs (
  job_id uuid PRIMARY KEY,
  body jsonb NOT NULL
);

CREATE TABLE generations (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL,
  body jsonb NOT NULL
);

CREATE TABLE revisions (
  project_id uuid NOT NULL,
  number int NOT NULL,
  body jsonb NOT NULL,
  PRIMARY KEY (project_id, number)
);

CREATE TABLE reviews (
  project_id uuid NOT NULL,
  revision int NOT NULL,
  body jsonb NOT NULL,
  PRIMARY KEY (project_id, revision)
);

CREATE TABLE previews (
  project_id uuid NOT NULL,
  revision int NOT NULL,
  body jsonb NOT NULL,
  PRIMARY KEY (project_id, revision)
);

CREATE TABLE published_versions (
  project_id uuid NOT NULL,
  version int NOT NULL,
  body jsonb NOT NULL,
  PRIMARY KEY (project_id, version)
);

CREATE TABLE reservations (
  id uuid PRIMARY KEY,
  job_id uuid NOT NULL,
  attempt int NOT NULL,
  batch_id text,
  usd_micros bigint NOT NULL,
  settled boolean NOT NULL DEFAULT false
);
CREATE INDEX reservations_job ON reservations (job_id) WHERE NOT settled;

CREATE TABLE audit_events (
  id uuid PRIMARY KEY,
  created_at timestamptz NOT NULL,
  body jsonb NOT NULL
);
