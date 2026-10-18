-- One encrypted vault per account. Nothing here identifies a person:
-- id and auth_hash are derived from the user's secret code, data is AES-GCM ciphertext.
CREATE TABLE IF NOT EXISTS vaults (
  id TEXT PRIMARY KEY,
  auth_hash TEXT NOT NULL,
  iv TEXT NOT NULL,
  data TEXT NOT NULL,
  version INTEGER NOT NULL
);
