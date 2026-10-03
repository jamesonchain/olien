-- Two facts the projection did not keep.
--
-- A key's end. A key minted for a payroll job in September proposed forever unless
-- someone remembered to revoke it, and the keys nobody remembers are the ones that
-- leak. Every key now has a last day, ninety days out unless its minter chose
-- otherwise, and the ones that already exist get ninety days from this migration
-- rather than staying eternal.
ALTER TABLE olien_api_keys ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
UPDATE olien_api_keys SET expires_at = now() + interval '90 days' WHERE expires_at IS NULL AND revoked_at IS NULL;

-- Whether a passkey lives in a cloud account rather than on one device, as its
-- authenticator said at enrolment. Two synced passkeys can be one key, and only the
-- browser that enrolled one ever knew which kind it was. Null means nobody said.
ALTER TABLE olien_signers ADD COLUMN IF NOT EXISTS synced BOOLEAN;
