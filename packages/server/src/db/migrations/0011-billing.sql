-- Billing spec §5: which Stripe customer and subscription belong to an account, and the Stripe
-- event ids already handled. Only ids, a status and dates are kept; never an email or an amount.
CREATE TABLE billing (
  account_id uuid PRIMARY KEY REFERENCES accounts(id),
  stripe_customer_id text NOT NULL UNIQUE,
  body jsonb NOT NULL
);

CREATE TABLE stripe_events (
  id text PRIMARY KEY,
  received_at timestamptz NOT NULL
);

CREATE INDEX stripe_events_received ON stripe_events (received_at);
