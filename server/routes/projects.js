import express from 'express';
import { newRepoToken, requireRole } from '../auth.js';
import { TOOL_IDS } from '../tools/catalog.js';
import { ah, bad, HttpError, json, notFound } from '../util.js';
import { createScan, rowToFinding, scanSummary } from '../scan/store.js';
import { assertProject, visibleProjectIds } from '../access.js';
import { DEFAULT_GATE, validGate } from '../gate.js';

const REPO_RE = /^[a-z0-9._-]{2,60}$/;
const GIT_RE = /^(https?:\/\/|ssh:\/\/|git@)\S+$/;
const SEV_ORDER = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
const intId = (v) => (Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : null);

export function repoView(r) {
  return {
    id: r.id, name: r.name, projectId: r.project_id, projectName: r.project_name || '', lang: r.lang, branch: r.branch,
    gitUrl: r.git_url || '', tools: json(r.tools, null), schedule: r.schedule, tokenHint: r.token_hint, createdAt: r.created_at,
    gate: { ...DEFAULT_GATE, ...json(r.gate, {}) },
    remote: r.remote_integration_id ? { integrationId: r.remote_integration_id, fullName: r.remote_full_name, webUrl: r.remote_web_url || null } : null,
  };
}

/** Scan with findings. With a user, a scan in a project they cannot see is a 404. */
export async function loadScanDetail(db, id, user) {
  const s = intId(id) && await db.get('SELECT s.*, r.project_id FROM scans s JOIN repos r ON r.id = s.repo_id WHERE s.id = ?', intId(id));
  if (!s) throw notFound('ไม่พบผลสแกน');
  if (user) await assertProject(db, user, s.project_id, 'ไม่พบผลสแกน');
  const prev = await db.get(`SELECT id, num FROM scans WHERE repo_id = ? AND status = 'done' AND num < ? ORDER BY num DESC LIMIT 1`, s.repo_id, s.num);
  const findings = (await db.all('SELECT * FROM findings WHERE scan_id = ?', s.id)).map(rowToFinding)
    .sort((a, b) => (a.status === 'fixed') - (b.status === 'fixed') || SEV_ORDER[a.severity] - SEV_ORDER[b.severity] || a.location.localeCompare(b.location))
    .map(({ fingerprint, ...f }) => f);
  return { ...scanSummary(s), repoId: s.repo_id, prev: prev ? { id: prev.id, num: prev.num } : null, runs: json(s.runs, []), findings };
}

export function projectRoutes({ db, queue, runner }) {
  const r = express.Router();
  const manage = requireRole('ADMIN', 'MAINTAINER');

  // Both loaders hide projects the user cannot see (404)
  const loadRepo = async (req, id) => {
    const repo = intId(id) && await db.get('SELECT r.*, p.name AS project_name FROM repos r JOIN projects p ON p.id = r.project_id WHERE r.id = ?', intId(id));
    if (!repo) throw notFound('ไม่พบ repo');
    await assertProject(db, req.user, repo.project_id, 'ไม่พบ repo');
    return repo;
  };
  const loadProject = async (req, id) => {
    const p = intId(id) && await db.get('SELECT * FROM projects WHERE id = ?', intId(id));
    if (!p) throw notFound('ไม่พบโปรเจกต์');
    await assertProject(db, req.user, p.id, 'ไม่พบโปรเจกต์');
    return p;
  };
  const cleanName = (n) => {
    const s = String(n || '').trim();
    if (s.length < 2 || s.length > 80) throw bad('ชื่อโปรเจกต์ต้องยาว 2–80 ตัวอักษร');
    return s;
  };
  function validTools(t) {
    if (t === null || t === undefined) return null;
    if (!Array.isArray(t)) throw bad('tools ต้องเป็น array');
    const unknown = t.find((x) => !TOOL_IDS.includes(x));
    if (unknown) throw bad(`ไม่รู้จัก scanner: ${unknown}`);
    return t.length ? JSON.stringify([...new Set(t)]) : null;
  }
  const validGit = (u) => {
    const s = String(u || '').trim();
    if (s && !GIT_RE.test(s)) throw bad('Git URL ต้องขึ้นต้นด้วย https://, ssh:// หรือ git@');
    return s || null;
  };
  const validSchedule = (s) => {
    if (s === undefined) return 'none';
    if (!['none', 'daily'].includes(s)) throw bad('schedule ต้องเป็น none หรือ daily');
    return s;
  };
  const gateJson = (g, current) => {
    try { return JSON.stringify(validGate(g, current)); } catch (e) { throw bad(e.message); }
  };
  const repoName = (n) => {
    const name = String(n || '').trim().toLowerCase();
    if (!REPO_RE.test(name)) throw bad('ชื่อ repo ใช้ได้เฉพาะ a-z 0-9 . _ - ยาว 2–60 ตัว');
    return name;
  };

  /* ---------- projects ---------- */
  r.get('/projects', ah(async (req, res) => {
    const visible = await visibleProjectIds(db, req.user);
    const projects = (await db.all('SELECT * FROM projects ORDER BY name')).filter((p) => visible === null || visible.has(p.id));
    const repos = await db.all('SELECT * FROM repos ORDER BY name');
    // latest finished scan per repo (done or failed, so a failed scan shows on the list), else the queued / running one.
    // While a scan runs the list keeps showing the previous result, with `running` set.
    const last = await db.all(`
      SELECT DISTINCT ON (repo_id) * FROM scans
      ORDER BY repo_id, (status IN ('done', 'failed')) DESC, num DESC`);
    const lastBy = new Map(last.map((s) => [s.repo_id, s]));
    const running = new Set((await db.all(`SELECT DISTINCT repo_id FROM scans WHERE status IN ('queued', 'running')`)).map((x) => x.repo_id));
    res.json(projects.map((p) => ({
      id: p.id, name: p.name,
      repos: repos.filter((x) => x.project_id === p.id).map((repo) => ({
        id: repo.id, name: repo.name, lang: repo.lang, branch: repo.branch, gitUrl: repo.git_url || '', schedule: repo.schedule,
        lastScan: lastBy.has(repo.id) ? scanSummary(lastBy.get(repo.id)) : null, running: running.has(repo.id),
      })),
    })));
  }));

  r.post('/projects', manage, ah(async (req, res) => {
    const name = cleanName(req.body?.name);
    // The creator gets a direct grant so they keep seeing the project
    const id = await db.tx(async (q) => {
      const { id: pid } = await q.run('INSERT INTO projects (name) VALUES (?) RETURNING id', name);
      await q.run('INSERT INTO project_grants (user_id, project_id) VALUES (?, ?) ON CONFLICT DO NOTHING', req.user.id, pid);
      return pid;
    });
    res.status(201).json({ id, name, repos: [] });
  }));

  r.patch('/projects/:id', manage, ah(async (req, res) => {
    const p = await loadProject(req, req.params.id);
    const name = cleanName(req.body?.name);
    await db.run('UPDATE projects SET name = ? WHERE id = ?', name, p.id);
    res.json({ id: p.id, name });
  }));

  r.delete('/projects/:id', manage, ah(async (req, res) => {
    const p = await loadProject(req, req.params.id);
    if (await db.get('SELECT id FROM repos WHERE project_id = ? LIMIT 1', p.id)) throw new HttpError(409, 'ลบไม่ได้ ยังมี repo อยู่ในโปรเจกต์นี้');
    await db.run('DELETE FROM projects WHERE id = ?', p.id);
    res.json({ ok: true });
  }));

  /* ---------- repos ---------- */
  r.post('/repos', manage, ah(async (req, res) => {
    const b = req.body || {};
    const p = await loadProject(req, b.projectId);
    const name = repoName(b.name);
    if (await db.get('SELECT id FROM repos WHERE name = ?', name)) throw new HttpError(409, 'มี repo ชื่อนี้แล้ว');
    const tok = newRepoToken();
    const { id } = await db.run(
      'INSERT INTO repos (name, project_id, lang, branch, git_url, tools, schedule, token_hash, token_hint, gate) VALUES (?, ?, ?, ?, ?, ?::jsonb, ?, ?, ?, ?::jsonb) RETURNING id',
      name, p.id, String(b.lang || '').slice(0, 40), String(b.branch || 'main').trim() || 'main', validGit(b.gitUrl),
      validTools(b.tools), validSchedule(b.schedule), tok.hash, tok.hint, gateJson(b.gate || {}),
    );
    res.status(201).json({ repo: repoView(await loadRepo(req, id)), token: tok.token });
  }));

  r.get('/repos/:id', ah(async (req, res) => res.json(repoView(await loadRepo(req, req.params.id)))));

  r.patch('/repos/:id', manage, ah(async (req, res) => {
    const repo = await loadRepo(req, req.params.id);
    const b = req.body || {};
    const sets = [];
    if (b.name !== undefined) {
      const name = repoName(b.name);
      if (await db.get('SELECT id FROM repos WHERE name = ? AND id <> ?', name, repo.id)) throw new HttpError(409, 'มี repo ชื่อนี้แล้ว');
      sets.push(['name', name]);
    }
    if (b.projectId !== undefined) sets.push(['project_id', (await loadProject(req, b.projectId)).id]);
    if (b.lang !== undefined) sets.push(['lang', String(b.lang || '').slice(0, 40)]);
    if (b.branch !== undefined) sets.push(['branch', String(b.branch || 'main').trim() || 'main']);
    if (b.gitUrl !== undefined) sets.push(['git_url', validGit(b.gitUrl)]);
    if (b.tools !== undefined) sets.push(['tools', validTools(b.tools)]);
    if (b.schedule !== undefined) sets.push(['schedule', validSchedule(b.schedule)]);
    if (b.gate !== undefined) sets.push(['gate', gateJson(b.gate, json(repo.gate, {}))]);
    for (const [col, v] of sets) {
      await db.run(`UPDATE repos SET ${col} = ?${col === 'tools' || col === 'gate' ? '::jsonb' : ''} WHERE id = ?`, v, repo.id);
    }
    res.json(repoView(await loadRepo(req, repo.id)));
  }));

  r.delete('/repos/:id', manage, ah(async (req, res) => {
    const repo = await loadRepo(req, req.params.id);
    if (queue.isBusy(repo.id)) throw new HttpError(409, 'repo นี้กำลังสแกนอยู่ รอให้เสร็จก่อนแล้วค่อยลบ');
    await db.run('DELETE FROM repos WHERE id = ?', repo.id);
    res.json({ ok: true });
  }));

  r.post('/repos/:id/token', manage, ah(async (req, res) => {
    const repo = await loadRepo(req, req.params.id);
    const tok = newRepoToken();
    await db.run('UPDATE repos SET token_hash = ?, token_hint = ? WHERE id = ?', tok.hash, tok.hint, repo.id);
    res.json({ token: tok.token });
  }));

  r.get('/repos/:id/scans', ah(async (req, res) => {
    const repo = await loadRepo(req, req.params.id);
    res.json((await db.all('SELECT * FROM scans WHERE repo_id = ? ORDER BY num DESC LIMIT 100', repo.id)).map(scanSummary));
  }));

  r.post('/repos/:id/scan', requireRole('ADMIN', 'MAINTAINER', 'ANALYST'), ah(async (req, res) => {
    const repo = await loadRepo(req, req.params.id);
    if (!repo.git_url) throw bad('repo นี้ยังไม่มี Git URL ให้เชื่อมผ่าน CI หรือใส่ Git URL ก่อน');
    const branch = req.body?.branch ? String(req.body.branch).trim() : repo.branch;
    const scan = await createScan(db, repo, { trigger: 'manual', branch });
    queue.add(scan, runner.fromGit());
    res.status(202).json({ scan: scanSummary(scan) });
  }));

  /* ---------- scan detail ---------- */
  r.get('/scans/:id', ah(async (req, res) => res.json(await loadScanDetail(db, req.params.id, req.user))));

  return r;
}
