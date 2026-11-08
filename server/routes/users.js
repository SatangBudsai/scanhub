import express from 'express';
import { hashPassword, normalizeRole, requireRole, ROLES } from '../auth.js';
import { ah, bad, HttpError, notFound } from '../util.js';

const USER_RE = /^[a-z0-9._-]{2,40}$/;

/** Validate an array of ids that must exist in a table; returns unique numbers */
export async function idList(db, v, table, label) {
  if (!Array.isArray(v)) throw bad(`${label} ต้องเป็น array`);
  const ids = [...new Set(v.map(Number))];
  if (ids.some((n) => !Number.isInteger(n) || n <= 0)) throw bad(`${label} ไม่ถูกต้อง`);
  if (!ids.length) return ids;
  const found = await db.all(`SELECT id FROM ${table} WHERE id = ANY(?::bigint[])`, ids);
  if (found.length !== ids.length) throw bad(`${label} มีรายการที่ไม่มีอยู่`);
  return ids;
}

export function userRoutes({ db }) {
  const r = express.Router();
  r.use(requireRole('ADMIN'));

  async function view(u) {
    const projectIds = (await db.all('SELECT project_id FROM project_grants WHERE user_id = ? ORDER BY project_id', u.id)).map((x) => x.project_id);
    const groupIds = (await db.all('SELECT group_id FROM group_members WHERE user_id = ? ORDER BY group_id', u.id)).map((x) => x.group_id);
    return {
      id: u.id, username: u.username, role: u.role, active: !!u.active, mustChange: !!u.must_change,
      fromEnv: !!u.from_env, lastLoginAt: u.last_login_at || null, createdAt: u.created_at,
      allProjects: !!u.all_projects || !!u.from_env, projectIds, groupIds,
    };
  }

  const load = async (id) => {
    const u = Number.isInteger(Number(id)) ? await db.get('SELECT * FROM users WHERE id = ?', Number(id)) : null;
    if (!u) throw notFound('ไม่พบผู้ใช้');
    return u;
  };

  r.get('/', ah(async (req, res) => {
    const users = await db.all('SELECT * FROM users ORDER BY from_env DESC, username');
    res.json(await Promise.all(users.map(view)));
  }));

  r.post('/', ah(async (req, res) => {
    const username = String(req.body?.username || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    const role = normalizeRole(req.body?.role || 'VIEWER');
    if (!USER_RE.test(username)) throw bad('ชื่อผู้ใช้ใช้ได้เฉพาะ a-z 0-9 . _ - ยาว 2–40 ตัว');
    if (password.length < 8) throw bad('รหัสผ่านชั่วคราวต้องมีอย่างน้อย 8 ตัวอักษร');
    if (!ROLES.includes(role)) throw bad('role ไม่ถูกต้อง');
    if (await db.get('SELECT id FROM users WHERE username = ?', username)) throw new HttpError(409, 'มีชื่อผู้ใช้นี้แล้ว');
    const { id } = await db.run(
      'INSERT INTO users (username, pass_hash, role, active, must_change, from_env, all_projects) VALUES (?, ?, ?, 1, 1, 0, 0) RETURNING id',
      username, await hashPassword(password), role,
    );
    res.status(201).json(await view(await load(id)));
  }));

  r.patch('/:id', ah(async (req, res) => {
    const u = await load(req.params.id);
    if (u.from_env) throw bad('บัญชี admin ตั้งค่าจาก env แก้จากหน้านี้ไม่ได้');
    const { active, allProjects, projectIds, groupIds } = req.body || {};
    const role = req.body?.role === undefined ? undefined : normalizeRole(req.body.role);
    if (role !== undefined && !ROLES.includes(role)) throw bad('role ไม่ถูกต้อง');
    const pids = projectIds !== undefined ? await idList(db, projectIds, 'projects', 'projectIds') : null;
    const gids = groupIds !== undefined ? await idList(db, groupIds, 'groups', 'groupIds') : null;
    await db.tx(async (q) => {
      if (role !== undefined) await q.run('UPDATE users SET role = ? WHERE id = ?', role, u.id);
      if (active !== undefined) {
        await q.run('UPDATE users SET active = ? WHERE id = ?', active ? 1 : 0, u.id);
        if (!active) await q.run('DELETE FROM sessions WHERE user_id = ?', u.id);
      }
      if (allProjects !== undefined) await q.run('UPDATE users SET all_projects = ? WHERE id = ?', allProjects ? 1 : 0, u.id);
      if (pids) {
        await q.run('DELETE FROM project_grants WHERE user_id = ?', u.id);
        for (const p of pids) await q.run('INSERT INTO project_grants (user_id, project_id) VALUES (?, ?)', u.id, p);
      }
      if (gids) {
        await q.run('DELETE FROM group_members WHERE user_id = ?', u.id);
        for (const g of gids) await q.run('INSERT INTO group_members (group_id, user_id) VALUES (?, ?)', g, u.id);
      }
    });
    res.json(await view(await load(u.id)));
  }));

  r.post('/:id/reset-password', ah(async (req, res) => {
    const u = await load(req.params.id);
    if (u.from_env) throw bad('รหัสผ่าน admin ตั้งค่าจาก env แก้จากหน้านี้ไม่ได้');
    const password = String(req.body?.password || '');
    if (password.length < 8) throw bad('รหัสผ่านชั่วคราวต้องมีอย่างน้อย 8 ตัวอักษร');
    await db.run('UPDATE users SET pass_hash = ?, must_change = 1 WHERE id = ?', await hashPassword(password), u.id);
    await db.run('DELETE FROM sessions WHERE user_id = ?', u.id);
    res.json(await view(await load(u.id)));
  }));

  return r;
}
