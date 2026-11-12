import express from 'express';
import { newRepoToken, requireRole } from '../auth.js';
import { TOOL_IDS } from '../tools/catalog.js';
import { ah, bad, HttpError, json, notFound } from '../util.js';
import { createScan, rowToFinding, scanSummary } from '../scan/store.js';
import { assertProject, visibleProjectIds } from '../access.js';
import { DEFAULT_GATE, validGate } from '../gate.js';
import { baselineScan, LINE_SQL, lineOf, refsOf, REF_KINDS, validRefs } from '../scan/refs.js';

const REPO_RE = /^[a-z0-9._-]{2,60}$/;
const GIT_RE = /^(https?:\/\/|ssh:\/\/|git@)\S+$/;
const SEV_ORDER = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
const intId = (v) => (Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : null);

export function repoView(r) {
  return {
    id: r.id, name: r.name, projectId: r.project_id, projectName: r.project_name || '', lang: r.lang, branch: r.branch,
    gitUrl: r.git_url || '', tools: json(r.tools, null), schedule: r.schedule, tokenHint: r.token_hint, createdAt: r.created_at,
    gate: { ...DEFAULT_GATE, ...json(r.gate, {}) },
    scanRefs: (({ branches, tags, prs }) => ({ branches, tags, prs }))(refsOf(r)),
    remote: r.remote_integration_id ? { integrationId: r.remote_integration_id, fullName: r.remote_full_name, webUrl: r.remote_web_url || null } : null,
  };
}

/** Scan with findings. With a user, a scan in a project they cannot see is a 404. */
export async function loadScanDetail(db, id, user) {
  const s = intId(id) && await db.get('SELECT s.*, r.project_id FROM scans s JOIN repos r ON r.id = s.repo_id WHERE s.id = ?', intId(id));
  if (!s) throw notFound('Scan not found');
  if (user) await assertProject(db, user, s.project_id, 'Scan not found');
  const repo = await db.get('SELECT branch FROM repos WHERE id = ?', s.repo_id);
  const prev = await baselineScan(db, s, repo || {});
  const findings = (await db.all('SELECT * FROM findings WHERE scan_id = ?', s.id)).map(rowToFinding)
    .sort((a, b) => (a.status === 'fixed') - (b.status === 'fixed') || SEV_ORDER[a.severity] - SEV_ORDER[b.severity] || a.location.localeCompare(b.location))
    .map(({ fingerprint, ...f }) => f);
  return { ...scanSummary(s), repoId: s.repo_id, prev: prev ? { id: prev.id, num: prev.num, refType: prev.ref_type, branch: prev.branch } : null, runs: json(s.runs, []), findings };
}

export function projectRoutes({ db, queue, runner }) {
  const r = express.Router();
  const manage = requireRole('ADMIN', 'MAINTAINER');

  // Both loaders hide projects the user cannot see (404)
  const loadRepo = async (req, id) => {
    const repo = intId(id) && await db.get('SELECT r.*, p.name AS project_name FROM repos r JOIN projects p ON p.id = r.project_id WHERE r.id = ?', intId(id));
    if (!repo) throw notFound('Repo not found');
    await assertProject(db, req.user, repo.project_id, 'Repo not found');
    return repo;
  };
  const loadProject = async (req, id) => {
    const p = intId(id) && await db.get('SELECT * FROM projects WHERE id = ?', intId(id));
    if (!p) throw notFound('Project not found');
    await assertProject(db, req.user, p.id, 'Project not found');
    return p;
  };
  const cleanName = (n) => {
    const s = String(n || '').trim();
    if (s.length < 2 || s.length > 80) throw bad('Project name must be 2–80 characters');
    return s;
  };
  function validTools(t) {
    if (t === null || t === undefined) return null;
    if (!Array.isArray(t)) throw bad('tools must be an array');
    const unknown = t.find((x) => !TOOL_IDS.includes(x));
    if (unknown) throw bad(`Unknown scanner: ${unknown}`);
    return t.length ? JSON.stringify([...new Set(t)]) : null;
  }
  const validGit = (u) => {
    const s = String(u || '').trim();
    if (s && !GIT_RE.test(s)) throw bad('Git URL must start with https://, ssh:// or git@');
    return s || null;
  };
  const validSchedule = (s) => {
    if (s === undefined) return 'none';
    if (!['none', 'daily'].includes(s)) throw bad('schedule must be none or daily');
    return s;
  };
  const gateJson = (g, current) => {
    try { return JSON.stringify(validGate(g, current)); } catch (e) { throw bad(e.message); }
  };
  const repoName = (n) => {
    const name = String(n || '').trim().toLowerCase();
    if (!REPO_RE.test(name)) throw bad('Repo name may use only a-z 0-9 . _ - and be 2–60 characters');
    return name;
  };

  /* ---------- projects ---------- */
  r.get('/projects', ah(async (req, res) => {
    const visible = await visibleProjectIds(db, req.user);
    const projects = (await db.all('SELECT * FROM projects ORDER BY name')).filter((p) => visible === null || visible.has(p.id));
    const repos = await db.all('SELECT * FROM repos ORDER BY name');
    // latest finished scan per repo (done or failed, so a failed scan shows on the list), else the queued / running one.
    // While a scan runs the list keeps showing the previous result, with `running` set.
    // Prefer scans of the main branch, so pull request and tag scans do not change what the list shows
    const last = await db.all(`
      SELECT DISTINCT ON (s.repo_id) s.* FROM scans s JOIN repos r ON r.id = s.repo_id
      ORDER BY s.repo_id, (s.ref_type = 'branch' AND s.branch = r.branch) DESC, (s.status IN ('done', 'failed')) DESC, s.num DESC`);
    const lastBy = new Map(last.map((s) => [s.repo_id, s]));
    const running = new Set((await db.all(`SELECT DISTINCT repo_id FROM scans WHERE status IN ('queued', 'running')`)).map((x) => x.repo_id));
    res.json(projects.map((p) => ({
      id: p.id, name: p.name,
      repos: repos.filter((x) => x.project_id === p.id).map((repo) => ({
        id: repo.id, name: repo.name, lang: repo.lang, branch: repo.branch, gitUrl: repo.git_url || '', schedule: repo.schedule, linked: !!repo.remote_integration_id,
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
    if (await db.get('SELECT id FROM repos WHERE project_id = ? LIMIT 1', p.id)) throw new HttpError(409, 'Cannot delete: this project still has repos');
    await db.run('DELETE FROM projects WHERE id = ?', p.id);
    res.json({ ok: true });
  }));

  /* ---------- repos ---------- */
  r.post('/repos', manage, ah(async (req, res) => {
    const b = req.body || {};
    const p = await loadProject(req, b.projectId);
    const name = repoName(b.name);
    if (await db.get('SELECT id FROM repos WHERE name = ?', name)) throw new HttpError(409, 'A repo with this name already exists');
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
      if (await db.get('SELECT id FROM repos WHERE name = ? AND id <> ?', name, repo.id)) throw new HttpError(409, 'A repo with this name already exists');
      sets.push(['name', name]);
    }
    if (b.projectId !== undefined) sets.push(['project_id', (await loadProject(req, b.projectId)).id]);
    if (b.lang !== undefined) sets.push(['lang', String(b.lang || '').slice(0, 40)]);
    if (b.branch !== undefined) sets.push(['branch', String(b.branch || 'main').trim() || 'main']);
    if (b.gitUrl !== undefined) sets.push(['git_url', validGit(b.gitUrl)]);
    if (b.tools !== undefined) sets.push(['tools', validTools(b.tools)]);
    if (b.schedule !== undefined) sets.push(['schedule', validSchedule(b.schedule)]);
    if (b.gate !== undefined) sets.push(['gate', gateJson(b.gate, json(repo.gate, {}))]);
    if (b.scanRefs !== undefined) {
      try { sets.push(['scan_refs', JSON.stringify(validRefs(b.scanRefs, refsOf(repo)))]); } catch (e) { throw bad(e.message); }
    }
    for (const [col, v] of sets) {
      await db.run(`UPDATE repos SET ${col} = ?${['tools', 'gate', 'scan_refs'].includes(col) ? '::jsonb' : ''} WHERE id = ?`, v, repo.id);
    }
    res.json(repoView(await loadRepo(req, repo.id)));
  }));

  r.delete('/repos/:id', manage, ah(async (req, res) => {
    const repo = await loadRepo(req, req.params.id);
    if (queue.isBusy(repo.id)) throw new HttpError(409, 'This repo is being scanned. Wait for it to finish before deleting');
    await db.run('DELETE FROM repos WHERE id = ?', repo.id);
    res.json({ ok: true });
  }));

  r.post('/repos/:id/token', manage, ah(async (req, res) => {
    const repo = await loadRepo(req, req.params.id);
    const tok = newRepoToken();
    await db.run('UPDATE repos SET token_hash = ?, token_hint = ? WHERE id = ?', tok.hash, tok.hint, repo.id);
    res.json({ token: tok.token });
  }));

  /**
   * Scans, newest first. Filter to one history line with kind + ref (ref = branch, PR source branch or tag pattern),
   * or with of=<scan num> for the line that scan belongs to.
   */
  r.get('/repos/:id/scans', ah(async (req, res) => {
    const repo = await loadRepo(req, req.params.id);
    let line = null;
    if (req.query.of !== undefined) {
      const s = await db.get('SELECT * FROM scans WHERE repo_id = ? AND num = ?', repo.id, intId(req.query.of) || 0);
      if (!s) throw notFound('Scan not found');
      line = lineOf(s);
    } else if (req.query.kind !== undefined) {
      if (!REF_KINDS.includes(req.query.kind)) throw bad('kind must be branch, tag or pr');
      line = { kind: req.query.kind, name: String(req.query.ref || '') };
    }
    const rows = line
      ? await db.all(`SELECT * FROM scans WHERE repo_id = ? AND ref_type = ? AND ${LINE_SQL} = ? ORDER BY num DESC LIMIT 100`, repo.id, line.kind, line.name)
      : await db.all('SELECT * FROM scans WHERE repo_id = ? ORDER BY num DESC LIMIT 100', repo.id);
    res.json(rows.map(scanSummary));
  }));

  // Every history line with its scan count and latest scan. The main branch comes first.
  r.get('/repos/:id/refs', ah(async (req, res) => {
    const repo = await loadRepo(req, req.params.id);
    const rows = await db.all(`
      SELECT DISTINCT ON (ref_type, ${LINE_SQL}) *, ${LINE_SQL} AS line_name,
        COUNT(*) OVER (PARTITION BY ref_type, ${LINE_SQL}) AS line_count
      FROM scans WHERE repo_id = ?
      ORDER BY ref_type, ${LINE_SQL}, num DESC`, repo.id);
    const order = { branch: 0, pr: 1, tag: 2 };
    const out = rows.map((s) => ({
      kind: s.ref_type, ref: s.line_name, count: Number(s.line_count), main: s.ref_type === 'branch' && s.line_name === repo.branch,
      last: scanSummary(s),
    }));
    out.sort((a, b) => b.main - a.main || order[a.kind] - order[b.kind] || b.last.num - a.last.num);
    res.json(out);
  }));

  r.post('/repos/:id/scan', requireRole('ADMIN', 'MAINTAINER', 'ANALYST'), ah(async (req, res) => {
    const repo = await loadRepo(req, req.params.id);
    if (!repo.git_url) throw bad('This repo has no Git URL. Connect it through CI or add a Git URL first');
    const branch = req.body?.branch ? String(req.body.branch).trim() : repo.branch;
    const scan = await createScan(db, repo, { trigger: 'manual', branch });
    queue.add(scan, runner.fromGit());
    res.status(202).json({ scan: scanSummary(scan) });
  }));

  /* ---------- scan detail ---------- */
  r.get('/scans/:id', ah(async (req, res) => res.json(await loadScanDetail(db, req.params.id, req.user))));

  return r;
}
