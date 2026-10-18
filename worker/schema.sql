-- One encrypted vault per account. Nothing here identifies a person:
-- id and auth_hash are derived from the user's secret code, data is AES-GCM ciphertext.
CREATE TABLE IF NOT EXISTS vaults (
  id TEXT PRIMARY KEY,
  auth_hash TEXT NOT NULL,
  iv TEXT NOT NULL,
  data TEXT NOT NULL,
  version INTEGER NOT NULL
);

-- Day of last use per vault (date only), so abandoned vaults can be erased.
CREATE TABLE IF NOT EXISTS vault_activity (
  id TEXT PRIMARY KEY,
  day TEXT NOT NULL
);

-- Number of vaults created per day, to cap abuse without knowing who creates them.
CREATE TABLE IF NOT EXISTS daily_creations (
  day TEXT PRIMARY KEY,
  n INTEGER NOT NULL
);
