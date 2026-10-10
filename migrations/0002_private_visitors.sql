CREATE TABLE IF NOT EXISTS usage_ip_daily (
  site TEXT NOT NULL CHECK (site IN ('ip.bea.sh', 'ip.behnam.pro')),
  source TEXT NOT NULL,
  day TEXT NOT NULL,
  ip TEXT NOT NULL,
  country TEXT NOT NULL DEFAULT '',
  city TEXT NOT NULL DEFAULT '',
  provider TEXT NOT NULL DEFAULT '',
  web INTEGER NOT NULL CHECK (web >= 0),
  api INTEGER NOT NULL CHECK (api >= 0),
  errors INTEGER NOT NULL CHECK (errors >= 0 AND errors <= web + api),
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  PRIMARY KEY (site, source, day, ip)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS usage_ip_daily_retention ON usage_ip_daily(day);
CREATE INDEX IF NOT EXISTS usage_ip_daily_site_day ON usage_ip_daily(site, day);
