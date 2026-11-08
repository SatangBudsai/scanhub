-- Connections to GitHub / GitLab, used for one-click CI setup and cloning private repos
CREATE TABLE integrations (
  id BIGSERIAL PRIMARY KEY,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  token_enc TEXT NOT NULL,
  from_env INTEGER NOT NULL DEFAULT 0,
  account TEXT,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE repos ADD COLUMN remote_integration_id BIGINT REFERENCES integrations(id) ON DELETE SET NULL;
ALTER TABLE repos ADD COLUMN remote_full_name TEXT;
ALTER TABLE repos ADD COLUMN remote_web_url TEXT;
