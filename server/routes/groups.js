// Groups (ADMIN) and "who can see this project"
import express from 'express';
import { requireRole } from '../auth.js';
import { ah, bad, HttpError, notFound } from '../util.js';
import { idList } from './users.js';

export function groupRoutes({ db }) {
  const r = express.Router();
  const admin = requireRole('ADMIN');

  async function view(g) {
    const memberIds = (await db.all('SELECT user_id FROM group_members WHERE group_id = ? ORDER BY user_id', g.id)).map((x) => x.user_id);
    const projectIds = (await db.all('SELECT project_id FROM group_projects WHERE group_id = ? ORDER BY project_id', g.id)).map((x) => x.project_id);
    return { id: g.id, name: g.name, allProjects: !!g.all_projects, memberIds, projectIds, createdAt: g.created_at };
  }
  const load = async (id) => {
    const g = Number.isInteger(Number(id)) ? await db.get('SELECT * FROM groups WHERE id = ?', Number(id)) : null;
    if (!g) throw notFound('Group not found');
    return g;
  };
  const cleanName = (n) => {
    const s = String(n || '').trim();
    if (s.length < 2 || s.length > 60) throw bad('Group name must be 2–60 characters');
    return s;
  };

  async function save(id, b, isNew) {
    const name = b.name !== undefined || isNew ? cleanName(b.name) : null;
    if (name !== null && await db.get('SELECT id FROM groups WHERE name = ? AND id <> ?', name, id || 0)) throw new HttpError(409, 'A group with this name already exists');
    const members = b.memberIds !== undefined ? await idList(db, b.memberIds, 'users', 'memberIds') : null;
    const projects = b.projectIds !== undefined ? await idList(db, b.projectIds, 'projects', 'projectIds') : null;
    return db.tx(async (q) => {
      let gid = id;
      if (isNew) gid = (await q.run('INSERT INTO groups (name, all_projects) VALUES (?, ?) RETURNING id', name, b.allProjects ? 1 : 0)).id;
      else {
        if (name !== null) await q.run('UPDATE groups SET name = ? WHERE id = ?', name, gid);
        if (b.allProjects !== undefined) await q.run('UPDATE groups SET all_projects = ? WHERE id = ?', b.allProjects ? 1 : 0, gid);
      }
      if (members) {
        await q.run('DELETE FROM group_members WHERE group_id = ?', gid);
        for (const u of members) await q.run('INSERT INTO group_members (group_id, user_id) VALUES (?, ?)', gid, u);
      }
      if (projects) {
        await q.run('DELETE FROM group_projects WHERE group_id = ?', gid);
        for (const p of projects) await q.run('INSERT INTO group_projects (group_id, project_id) VALUES (?, ?)', gid, p);
      }
      return gid;
    });
  }

  r.get('/groups', admin, ah(async (req, res) => {
    res.json(await Promise.all((await db.all('SELECT * FROM groups ORDER BY name')).map(view)));
  }));
  r.post('/groups', admin, ah(async (req, res) => {
    const id = await save(null, req.body || {}, true);
    res.status(201).json(await view(await load(id)));
  }));
  r.patch('/groups/:id', admin, ah(async (req, res) => {
    const g = await load(req.params.id);
    await save(g.id, req.body || {}, false);
    res.json(await view(await load(g.id)));
  }));
  r.delete('/groups/:id', admin, ah(async (req, res) => {
    const g = await load(req.params.id);
    await db.run('DELETE FROM groups WHERE id = ?', g.id);
    res.json({ ok: true });
  }));

  // Who can see a project, and through what
  r.get('/projects/:id/access', admin, ah(async (req, res) => {
    const pid = Number(req.params.id);
    const p = Number.isInteger(pid) ? await db.get('SELECT id FROM projects WHERE id = ?', pid) : null;
    if (!p) throw notFound('Project not found');
    const groups = await db.all(
      `SELECT g.id, g.name FROM groups g
       WHERE g.all_projects = 1 OR EXISTS (SELECT 1 FROM group_projects gp WHERE gp.group_id = g.id AND gp.project_id = ?)
       ORDER BY g.name`, pid,
    );
    const groupIds = new Set(groups.map((g) => g.id));
    const memberships = await db.all('SELECT gm.user_id, g.id, g.name FROM group_members gm JOIN groups g ON g.id = gm.group_id');
    const direct = new Set((await db.all('SELECT user_id FROM project_grants WHERE project_id = ?', pid)).map((x) => x.user_id));
    const users = [];
    for (const u of await db.all('SELECT id, username, role, all_projects, from_env FROM users WHERE active = 1 ORDER BY username')) {
      const via = [];
      if (u.role === 'ADMIN' || u.all_projects || u.from_env) via.push('all');
      if (direct.has(u.id)) via.push('direct');
      for (const m of memberships) if (m.user_id === u.id && groupIds.has(m.id)) via.push(`group:${m.name}`);
      if (via.length) users.push({ id: u.id, username: u.username, via });
    }
    res.json({ users, groups });
  }));

  return r;
}
