-- Users must be created first (links references users)
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  email TEXT UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  is_blocked INTEGER NOT NULL DEFAULT 0,
  subscription_tier TEXT NOT NULL DEFAULT 'free',
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
  last_login INTEGER
);

CREATE TABLE IF NOT EXISTS links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL DEFAULT '',
  type TEXT NOT NULL DEFAULT 'url',
  destination TEXT,
  title TEXT,
  owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  manage_token_hash TEXT,
  password_hash TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  is_private INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
  created_ip TEXT,
  meta TEXT
);

CREATE INDEX IF NOT EXISTS idx_links_code ON links(code);
CREATE INDEX IF NOT EXISTS idx_links_owner ON links(owner_id);
CREATE INDEX IF NOT EXISTS idx_links_created ON links(created_at);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  data TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
);

CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS api_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  label TEXT,
  last_used INTEGER,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
);

CREATE TABLE IF NOT EXISTS tracking (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  link_id INTEGER NOT NULL REFERENCES links(id) ON DELETE CASCADE,
  visited_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
  ip TEXT,
  user_agent TEXT,
  referer TEXT
);

CREATE INDEX IF NOT EXISTS idx_tracking_link ON tracking(link_id);
CREATE INDEX IF NOT EXISTS idx_tracking_visited ON tracking(visited_at);

CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  link_id INTEGER NOT NULL REFERENCES links(id) ON DELETE CASCADE,
  reporter_ip TEXT,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
);

CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status);

CREATE TABLE IF NOT EXISTS blocked_ips (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cidr TEXT NOT NULL,
  reason TEXT,
  blocked_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS dns_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subdomain TEXT UNIQUE NOT NULL,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  ip4 TEXT,
  ip6 TEXT,
  secret_key_hash TEXT,
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
);

CREATE INDEX IF NOT EXISTS idx_dns_subdomain ON dns_records(subdomain);

CREATE TABLE IF NOT EXISTS bookmark_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  link_id INTEGER NOT NULL REFERENCES links(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  title TEXT,
  description TEXT,
  folder TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
);

CREATE INDEX IF NOT EXISTS idx_bookmark_items_link ON bookmark_items(link_id);
