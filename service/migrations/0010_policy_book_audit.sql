-- The address book, signed. An entry is what makes an address "known", and the
-- treasury policy trusts it, so a row has to be something the service cannot write by
-- itself: each one carries a member's signature over the address, the label and the
-- moment it was added, in the account's own EIP-712 domain. A row without one is a
-- row from before this, and counts for nothing until a member signs it.
ALTER TABLE olien_address_book ADD COLUMN IF NOT EXISTS signer_id TEXT;
ALTER TABLE olien_address_book ADD COLUMN IF NOT EXISTS signature BYTEA;
ALTER TABLE olien_address_book ADD COLUMN IF NOT EXISTS added_at BIGINT;

-- The treasury's own rules about money: approvals by amount, known destinations, hours.
-- `pending` is a change that loosens them, waiting out the account's config delay, which
-- any member may cancel before `pending_effective_at`.
CREATE TABLE IF NOT EXISTS olien_policies (
    olien_id BIGINT PRIMARY KEY REFERENCES olien_accounts(id) ON DELETE CASCADE,
    policy JSONB NOT NULL DEFAULT '{}'::jsonb,
    pending JSONB,
    pending_effective_at BIGINT,
    pending_by BIGINT REFERENCES accounts(account_id) ON DELETE SET NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Who did what, in order. `previous` and `hash` chain each row to the one before it
-- for the same account, so a row altered or removed afterwards shows.
CREATE TABLE IF NOT EXISTS olien_audit (
    id BIGSERIAL PRIMARY KEY,
    olien_id BIGINT NOT NULL REFERENCES olien_accounts(id) ON DELETE CASCADE,
    at TIMESTAMPTZ NOT NULL,
    actor BIGINT REFERENCES accounts(account_id) ON DELETE SET NULL,
    api_key_id BIGINT REFERENCES olien_api_keys(id) ON DELETE SET NULL,
    action TEXT NOT NULL,
    subject TEXT,
    detail JSONB NOT NULL DEFAULT '{}'::jsonb,
    previous TEXT NOT NULL,
    hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS olien_audit_account_idx ON olien_audit (olien_id, id DESC);
