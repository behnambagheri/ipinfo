CREATE TABLE appearance_settings (
  site TEXT PRIMARY KEY CHECK (site IN ('ip.bea.sh', 'ip.behnam.pro')),
  accent TEXT NOT NULL CHECK (accent IN ('blue', 'teal', 'cyan', 'indigo', 'violet', 'fuchsia'))
);
