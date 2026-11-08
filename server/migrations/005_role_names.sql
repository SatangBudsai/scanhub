-- Rename roles to match what each one does in a security scanning tool
UPDATE users SET role = CASE role
  WHEN 'SA' THEN 'MAINTAINER'
  WHEN 'QA' THEN 'ANALYST'
  WHEN 'DEVELOPER' THEN 'VIEWER'
  ELSE role END
WHERE role IN ('SA', 'QA', 'DEVELOPER');
