-- Branch / tag / pull request scans, each compared with the right earlier scan
-- ref_type: branch | tag | pr. branch holds the branch, tag or PR source branch name.
-- base_branch: target branch of a pull request. ref_group: the tag pattern a tag matched (e.g. sit_v*).
ALTER TABLE scans ADD COLUMN ref_type TEXT NOT NULL DEFAULT 'branch';
ALTER TABLE scans ADD COLUMN base_branch TEXT NOT NULL DEFAULT '';
ALTER TABLE scans ADD COLUMN ref_group TEXT NOT NULL DEFAULT '';
UPDATE scans s SET branch = r.branch FROM repos r WHERE s.repo_id = r.id AND s.branch = '';
CREATE INDEX scans_repo_ref ON scans (repo_id, ref_type, branch, num DESC);

-- What CI may scan. Empty branches = only the repo's main branch. Empty tags = no tags.
ALTER TABLE repos ADD COLUMN scan_refs JSONB NOT NULL DEFAULT '{"branches":[],"tags":[],"prs":true}';
