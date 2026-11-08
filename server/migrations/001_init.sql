CREATE TABLE users (
  id BIGSERIAL PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  pass_hash TEXT NOT NULL,
  role TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  must_change INTEGER NOT NULL DEFAULT 0,
  from_env INTEGER NOT NULL DEFAULT 0,
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user ON sessions(user_id);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value JSONB
);

CREATE TABLE projects (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE repos (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  project_id BIGINT NOT NULL REFERENCES projects(id),
  lang TEXT NOT NULL DEFAULT '',
  branch TEXT NOT NULL DEFAULT 'main',
  git_url TEXT,
  tools JSONB,
  schedule TEXT NOT NULL DEFAULT 'none',
  token_hash TEXT NOT NULL UNIQUE,
  token_hint TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE scans (
  id BIGSERIAL PRIMARY KEY,
  repo_id BIGINT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  num INTEGER NOT NULL,
  status TEXT NOT NULL,
  trigger TEXT NOT NULL,
  branch TEXT,
  commit_sha TEXT,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  duration_ms INTEGER,
  counts JSONB NOT NULL DEFAULT '[0,0,0,0,0]',
  open_count INTEGER NOT NULL DEFAULT 0,
  new_count INTEGER NOT NULL DEFAULT 0,
  fixed_count INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  runs JSONB NOT NULL DEFAULT '[]',
  tools_req JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (repo_id, num)
);
CREATE INDEX scans_repo ON scans(repo_id, num DESC);
CREATE INDEX scans_status ON scans(status);

CREATE TABLE findings (
  id BIGSERIAL PRIMARY KEY,
  scan_id BIGINT NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  repo_id BIGINT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  fingerprint TEXT NOT NULL,
  severity TEXT NOT NULL,
  category TEXT NOT NULL,
  title TEXT NOT NULL,
  location TEXT,
  file TEXT,
  line INTEGER,
  pkg TEXT,
  version TEXT,
  rules JSONB NOT NULL DEFAULT '[]',
  tools JSONB NOT NULL DEFAULT '[]',
  fix TEXT,
  description TEXT,
  snippet JSONB,
  refs JSONB NOT NULL DEFAULT '[]',
  status TEXT NOT NULL,
  first_seen_num INTEGER
);
CREATE INDEX findings_scan ON findings(scan_id);
CREATE INDEX findings_repo_fp ON findings(repo_id, fingerprint);

CREATE TABLE tools (
  id TEXT PRIMARY KEY,
  installed INTEGER NOT NULL DEFAULT 0,
  version TEXT,
  bin TEXT,
  updated_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'idle',
  error TEXT
);

CREATE TABLE tool_log (
  id BIGSERIAL PRIMARY KEY,
  at TIMESTAMPTZ NOT NULL DEFAULT now(),
  tool TEXT NOT NULL,
  action TEXT NOT NULL,
  ok INTEGER NOT NULL,
  message TEXT
);

CREATE TABLE shares (
  id BIGSERIAL PRIMARY KEY,
  scan_id BIGINT NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  token_hint TEXT NOT NULL,
  mode TEXT NOT NULL,
  pass_hash TEXT,
  options JSONB NOT NULL DEFAULT '{}',
  expires_at TIMESTAMPTZ,
  revoked INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_viewed_at TIMESTAMPTZ,
  views INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX shares_scan ON shares(scan_id);
