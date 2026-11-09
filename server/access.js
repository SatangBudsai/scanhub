// Which projects a user can see. ADMIN and "all projects" users see everything.
import { HttpError } from './util.js';

/** null = every project; otherwise a Set of project ids */
export async function visibleProjectIds(db, user) {
  if (!user) return new Set();
  if (user.role === 'ADMIN' || user.all_projects) return null;
  const all = await db.get(
    'SELECT 1 AS ok FROM groups g JOIN group_members gm ON gm.group_id = g.id WHERE gm.user_id = ? AND g.all_projects = 1 LIMIT 1',
    user.id,
  );
  if (all) return null;
  const rows = await db.all(
    `SELECT project_id FROM project_grants WHERE user_id = ?
     UNION
     SELECT gp.project_id FROM group_projects gp JOIN group_members gm ON gm.group_id = gp.group_id WHERE gm.user_id = ?`,
    user.id, user.id,
  );
  return new Set(rows.map((r) => r.project_id));
}

export async function canSeeProject(db, user, projectId) {
  const ids = await visibleProjectIds(db, user);
  return ids === null || ids.has(Number(projectId));
}

/** 404 (not 403) so a hidden project looks like it does not exist */
export async function assertProject(db, user, projectId, message = 'Not found') {
  if (!(await canSeeProject(db, user, projectId))) throw new HttpError(404, message);
}

/** Project id that owns a scan, or null */
export async function projectOfScan(db, scanId) {
  const r = await db.get('SELECT r.project_id FROM scans s JOIN repos r ON r.id = s.repo_id WHERE s.id = ?', scanId);
  return r ? r.project_id : null;
}
