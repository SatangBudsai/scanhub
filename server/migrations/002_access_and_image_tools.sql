-- Project access: direct grants, groups, all-projects flags
ALTER TABLE users ADD COLUMN all_projects INTEGER NOT NULL DEFAULT 0;
-- Users that existed before project access keep seeing everything
UPDATE users SET all_projects = 1;

CREATE TABLE project_grants (
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, project_id)
);
CREATE INDEX project_grants_project ON project_grants(project_id);

CREATE TABLE groups (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  all_projects INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE group_members (
  group_id BIGINT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (group_id, user_id)
);
CREATE INDEX group_members_user ON group_members(user_id);
CREATE TABLE group_projects (
  group_id BIGINT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  PRIMARY KEY (group_id, project_id)
);
CREATE INDEX group_projects_project ON group_projects(project_id);

-- Scanners built into the image: enable / disable, and the image version.
-- installed / bin / version keep describing an update installed into DATA_DIR/tools (the override).
ALTER TABLE tools ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE tools ADD COLUMN image_version TEXT;
