CREATE TABLE IF NOT EXISTS usage_daily (
  site TEXT NOT NULL CHECK (site IN ('ip.bea.sh', 'ip.behnam.pro')),
  source TEXT NOT NULL,
  day TEXT NOT NULL,
  web INTEGER NOT NULL DEFAULT 0 CHECK (web >= 0),
  api INTEGER NOT NULL DEFAULT 0 CHECK (api >= 0),
  errors INTEGER NOT NULL DEFAULT 0 CHECK (errors >= 0 AND errors <= web + api),
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  PRIMARY KEY (site, source, day)
) WITHOUT ROWID;
