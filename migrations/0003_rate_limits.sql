CREATE TABLE rate_limit_settings (
  site TEXT PRIMARY KEY CHECK (site IN ('ip.bea.sh', 'ip.behnam.pro')),
  max_requests INTEGER NOT NULL CHECK (max_requests BETWEEN 0 AND 1000000),
  window_seconds INTEGER NOT NULL CHECK (window_seconds BETWEEN 1 AND 86400),
  revision TEXT NOT NULL
);

CREATE TABLE rate_limit_buckets (
  site TEXT NOT NULL,
  ip_key TEXT NOT NULL,
  revision TEXT NOT NULL,
  requests INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (site, ip_key)
);
CREATE INDEX rate_limit_bucket_expiry ON rate_limit_buckets (expires_at);
