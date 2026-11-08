-- Per-repo CI gate: block the pipeline or only report
ALTER TABLE repos ADD COLUMN gate JSONB NOT NULL DEFAULT '{"mode":"block","severities":["critical","high"],"scope":"new"}';
