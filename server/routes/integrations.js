// GitHub / GitLab connections and one-click CI setup
import express from 'express';
import { newRepoToken, requireRole } from '../auth.js';
import { assertProject } from '../access.js';
import { decrypt, encrypt } from '../secrets.js';
import { provider } from '../git/providers.js';
import { TOOL_IDS } from '../tools/catalog.js';
import { ah, bad, notFound } from '../util.js';
import { getServerUrl } from '../settings.js';
import { validGate } from '../gate.js';
import { json } from '../util.js';

const TYPES = ['github', 'gitlab'];
const DEFAULT_BASE = { github: 'https://api.github.com', gitlab: 'https://gitlab.com' };
const URL_RE = /^https?:\/\/\S+$/;

const view = (i) => ({
  id: i.id, type: i.type, name: i.name, baseUrl: i.base_url, tokenSet: !!i.token_enc, fromEnv: !!i.from_env,
  account: i.account || null, lastError: i.last_error || null,
});

/** Create / update / remove the read-only connections that come from env */
export async function syncEnvIntegrations(db) {
  const wanted = [];
  if (process.env.GITHUB_TOKEN) {
    wanted.push({ type: 'github', name: 'GitHub (env)', base: (process.env.GITHUB_API_URL || DEFAULT_BASE.github).replace(/\/+$/, ''), token: process.env.GITHUB_TOKEN });
  }
  if (process.env.GITLAB_URL && process.env.GITLAB_TOKEN) {
    wanted.push({ type: 'gitlab', name: 'GitLab (env)', base: process.env.GITLAB_URL.replace(/\/+$/, ''), token: process.env.GITLAB_TOKEN });
  }
  for (const t of TYPES) {
    const w = wanted.find((x) => x.type === t);
    const row = await db.get('SELECT id FROM integrations WHERE from_env = 1 AND type = ?', t);
    if (w && row) await db.run('UPDATE integrations SET name = ?, base_url = ?, token_enc = ? WHERE id = ?', w.name, w.base, await encrypt(db, w.token), row.id);
    else if (w) await db.run('INSERT INTO integrations (type, name, base_url, token_enc, from_env) VALUES (?, ?, ?, ?, 1)', t, w.name, w.base, await encrypt(db, w.token));
    else if (row) await db.run('DELETE FROM integrations WHERE id = ?', row.id);
  }
}

export async function integrationClient(db, id) {
  const i = Number.isInteger(Number(id)) ? await db.get('SELECT * FROM integrations WHERE id = ?', Number(id)) : null;
  if (!i) throw notFound('ไม่พบการเชื่อมต่อ');
  return { row: i, token: await decrypt(db, i.token_enc), api: provider(i.type, i.base_url, await decrypt(db, i.token_enc)) };
}

export function integrationRoutes({ db }) {
  const r = express.Router();
  const admin = requireRole('ADMIN');
  const manage = requireRole('ADMIN', 'SA');

  const load = async (id) => {
    const i = Number.isInteger(Number(id)) ? await db.get('SELECT * FROM integrations WHERE id = ?', Number(id)) : null;
    if (!i) throw notFound('ไม่พบการเชื่อมต่อ');
    return i;
  };

  // SA may list connections (to pick one for setup); tokens are never returned
  r.get('/integrations', manage, ah(async (req, res) => {
    res.json((await db.all('SELECT * FROM integrations ORDER BY from_env DESC, name')).map(view));
  }));

  r.post('/integrations', admin, ah(async (req, res) => {
    const b = req.body || {};
    if (!TYPES.includes(b.type)) throw bad('type ต้องเป็น github หรือ gitlab');
    const name = String(b.name || '').trim();
    if (name.length < 2 || name.length > 60) throw bad('ชื่อการเชื่อมต่อต้องยาว 2–60 ตัวอักษร');
    const base = String(b.baseUrl || DEFAULT_BASE[b.type]).trim().replace(/\/+$/, '');
    if (!URL_RE.test(base)) throw bad('URL ต้องขึ้นต้นด้วย http:// หรือ https://');
    const token = String(b.token || '').trim();
    if (!token) throw bad('ต้องใส่ token');
    const { id } = await db.run('INSERT INTO integrations (type, name, base_url, token_enc) VALUES (?, ?, ?, ?) RETURNING id', b.type, name, base, await encrypt(db, token));
    res.status(201).json(view(await load(id)));
  }));

  r.patch('/integrations/:id', admin, ah(async (req, res) => {
    const i = await load(req.params.id);
    if (i.from_env) throw bad('การเชื่อมต่อนี้ตั้งค่าจาก env แก้จากหน้านี้ไม่ได้');
    const b = req.body || {};
    if (b.name !== undefined) {
      const name = String(b.name).trim();
      if (name.length < 2 || name.length > 60) throw bad('ชื่อการเชื่อมต่อต้องยาว 2–60 ตัวอักษร');
      await db.run('UPDATE integrations SET name = ? WHERE id = ?', name, i.id);
    }
    if (b.baseUrl !== undefined) {
      const base = String(b.baseUrl).trim().replace(/\/+$/, '');
      if (!URL_RE.test(base)) throw bad('URL ต้องขึ้นต้นด้วย http:// หรือ https://');
      await db.run('UPDATE integrations SET base_url = ? WHERE id = ?', base, i.id);
    }
    if (typeof b.token === 'string' && b.token.trim()) {
      await db.run('UPDATE integrations SET token_enc = ?, account = NULL, last_error = NULL WHERE id = ?', await encrypt(db, b.token.trim()), i.id);
    }
    res.json(view(await load(i.id)));
  }));

  r.delete('/integrations/:id', admin, ah(async (req, res) => {
    const i = await load(req.params.id);
    if (i.from_env) throw bad('การเชื่อมต่อนี้ตั้งค่าจาก env ลบได้โดยเอาค่าออกจาก env แล้ว restart');
    await db.run('DELETE FROM integrations WHERE id = ?', i.id);
    res.json({ ok: true });
  }));

  r.post('/integrations/:id/test', admin, ah(async (req, res) => {
    const { row, api } = await integrationClient(db, req.params.id);
    try {
      const t = await api.test();
      await db.run('UPDATE integrations SET account = ?, last_error = NULL WHERE id = ?', t.account, row.id);
      res.json({ ...t, error: null });
    } catch (e) {
      await db.run('UPDATE integrations SET last_error = ? WHERE id = ?', String(e.message).slice(0, 500), row.id);
      res.json({ ok: false, account: null, scopesOk: false, missing: [], error: e.message });
    }
  }));

  r.get('/integrations/:id/repos', manage, ah(async (req, res) => {
    const { api } = await integrationClient(db, req.params.id);
    try {
      res.json(await api.repos(String(req.query.q || '').slice(0, 100)));
    } catch (e) {
      throw bad(`ดึงรายการ repo ไม่สำเร็จ: ${e.message}`);
    }
  }));

  // One-click CI setup
  r.post('/repos/:id/auto-setup', manage, ah(async (req, res) => {
    const id = Number(req.params.id);
    const repo = Number.isInteger(id) ? await db.get('SELECT * FROM repos WHERE id = ?', id) : null;
    if (!repo) throw notFound('ไม่พบ repo');
    await assertProject(db, req.user, repo.project_id, 'ไม่พบ repo');
    const b = req.body || {};
    const remoteRepo = String(b.remoteRepo || '').trim();
    if (!/^[\w.-]+(\/[\w.-]+)+$/.test(remoteRepo)) throw bad('remoteRepo ต้องเป็น owner/name');
    const mode = b.mode === 'commit' ? 'commit' : 'pr';
    const tools = b.tools == null ? null : (Array.isArray(b.tools) ? b.tools : null);
    if (tools && tools.some((t) => !TOOL_IDS.includes(t))) throw bad('tools มี scanner ที่ไม่รู้จัก');
    let gate;
    try { gate = validGate(b.gate || {}, json(repo.gate, {})); } catch (e) { throw bad(e.message); }
    const { row: integ, api } = await integrationClient(db, b.integrationId);

    // The pipeline reads its gate from the repo, so save it first
    await db.run('UPDATE repos SET gate = ?::jsonb WHERE id = ?', JSON.stringify(gate), repo.id);

    const steps = [];
    let failed = false;
    const step = async (key, fn) => {
      if (failed) return;
      try {
        steps.push({ key, ok: true, message: (await fn()) || 'สำเร็จ' });
      } catch (e) {
        failed = true;
        steps.push({ key, ok: false, message: e.message });
        throw e;
      }
    };

    let result = { prUrl: null, commitUrl: null };
    try {
      let scanhubToken;
      await step('token', async () => {
        const tok = newRepoToken();
        await db.run('UPDATE repos SET token_hash = ?, token_hint = ? WHERE id = ?', tok.hash, tok.hint, repo.id);
        scanhubToken = tok.token;
        return 'สร้าง token ใหม่ของ repo แล้ว (token เดิมใช้ไม่ได้)';
      });
      result = await api.autoSetup({
        fullName: remoteRepo, branch: b.branch ? String(b.branch) : null, mode, tools,
        scanhubToken, scanhubUrl: await getServerUrl(db),
      }, step);
      await step('link', async () => {
        const fill = !repo.git_url;
        await db.run(
          `UPDATE repos SET remote_integration_id = ?, remote_full_name = ?, remote_web_url = ?,
             git_url = COALESCE(NULLIF(git_url, ''), ?), branch = CASE WHEN ? THEN ? ELSE branch END WHERE id = ?`,
          integ.id, remoteRepo, result.webUrl || null, result.cloneUrl || null, fill, result.defaultBranch || repo.branch, repo.id,
        );
        return `ผูก repo กับ ${remoteRepo} แล้ว (CI gate: ${gate.mode === 'block' ? 'block' : 'รายงานอย่างเดียว'})`;
      });
    } catch (e) {
      // An error between steps (e.g. the repo lookup) counts as the next step failing.
      // Earlier steps are not rolled back.
      if (!failed) {
        failed = true;
        const next = ['token', 'secret', 'file', 'pr', 'link'].find((k) => !steps.some((s) => s.key === k)) || 'link';
        steps.push({ key: next, ok: false, message: e.message });
      }
    }
    res.json({ ok: !failed, prUrl: result.prUrl || null, commitUrl: result.commitUrl || null, steps });
  }));

  return r;
}
