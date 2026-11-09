// Customer reports and share links
import crypto from 'node:crypto';
import express from 'express';
import { appendCookie, hashPassword, parseCookies, requireRole, sessionUser, sha256, verifyPassword } from '../auth.js';
import { ah, bad, HttpError, notFound, nowIso, SEV, sevRank } from '../util.js';
import { getServerUrl } from '../settings.js';
import { loadScanDetail } from './projects.js';
import { assertProject, canSeeProject, projectOfScan } from '../access.js';

const STATUS_ORDER = { new: 0, existing: 1, fixed: 2 };
const UNLOCK_HOURS = 12;
const FAIL_WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILS = 5;

const bool = (v, d) => {
  if (v === undefined || v === null || v === '') return d;
  if (typeof v === 'boolean') return v;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
};
const text = (v, n = 200) => (v == null ? '' : String(v).trim().slice(0, n));

export function reportOptions(o = {}) {
  const minSeverity = SEV.includes(String(o.minSeverity || '').toLowerCase()) ? String(o.minSeverity).toLowerCase() : 'low';
  return {
    title: text(o.title), preparedFor: text(o.preparedFor),
    minSeverity, includeFixed: bool(o.includeFixed, false), includeSnippets: bool(o.includeSnippets, true),
  };
}

/** Read-only report of one scan. No internal ids, tokens or user names. */
export async function buildReport(db, scanId, rawOptions, user) {
  const options = reportOptions(rawOptions);
  const d = await loadScanDetail(db, scanId, user);
  if (d.status !== 'done') throw new HttpError(409, 'This scan is not finished or has failed, so a report cannot be created');
  const repo = await db.get('SELECT r.name, r.lang, r.branch, p.name AS project_name FROM repos r JOIN projects p ON p.id = r.project_id WHERE r.id = ?', d.repoId);
  const newBySeverity = Object.fromEntries(SEV.map((s) => [s, 0]));
  for (const f of d.findings) if (f.status === 'new') newBySeverity[f.severity]++;
  const findings = d.findings
    .filter((f) => sevRank(f.severity) <= sevRank(options.minSeverity) && (options.includeFixed || f.status !== 'fixed'))
    .sort((a, b) => sevRank(a.severity) - sevRank(b.severity) || STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.location.localeCompare(b.location))
    .map(({ id, ...f }) => (options.includeSnippets ? f : { ...f, snippet: null }));
  return {
    title: options.title || `Security scan report · ${repo.name}`,
    preparedFor: options.preparedFor,
    generatedAt: nowIso(),
    repo: { name: repo.name, projectName: repo.project_name, lang: repo.lang, branch: repo.branch },
    scan: { num: d.num, commit: d.commit, branch: d.branch, trigger: d.trigger, startedAt: d.startedAt, finishedAt: d.finishedAt, durationMs: d.durationMs },
    prev: d.prev ? { num: d.prev.num } : null,
    summary: { counts: d.counts, openCount: d.openCount, newCount: d.newCount, fixedCount: d.fixedCount, newBySeverity },
    runs: d.runs,
    findings,
    options,
  };
}

async function shareSecret(db) {
  let s = await db.getSetting('shareSecret', null);
  if (!s) {
    // First writer wins, so every server instance uses the same secret
    await db.run('INSERT INTO settings (key, value) VALUES (?, ?::jsonb) ON CONFLICT (key) DO NOTHING', 'shareSecret', JSON.stringify(crypto.randomBytes(32).toString('hex')));
    s = await db.getSetting('shareSecret', null);
  }
  return s;
}

const shareView = (s, url = null) => ({
  id: s.id, mode: s.mode, url, tokenHint: s.token_hint, createdAt: s.created_at, createdBy: s.created_by,
  expiresAt: s.expires_at || null, revoked: !!s.revoked, lastViewedAt: s.last_viewed_at || null, views: s.views, options: s.options,
});

/** Logged-in routes: export report, create / list / revoke share links */
export function reportRoutes({ db }) {
  const r = express.Router();
  const sharers = requireRole('ADMIN', 'MAINTAINER', 'ANALYST');

  r.get('/scans/:id/report', ah(async (req, res) => res.json(await buildReport(db, req.params.id, req.query, req.user))));

  r.post('/scans/:id/shares', sharers, ah(async (req, res) => {
    const b = req.body || {};
    const mode = b.mode;
    if (!['internal', 'password'].includes(mode)) throw bad('mode must be internal or password');
    let passHash = null;
    if (mode === 'password') {
      if (String(b.password || '').length < 8) throw bad('Link password must be at least 8 characters');
      passHash = await hashPassword(b.password);
    }
    let expiresAt = null;
    if (b.expiresInDays !== undefined && b.expiresInDays !== null) {
      const n = Number(b.expiresInDays);
      if (!Number.isInteger(n) || n < 1 || n > 365) throw bad('Link expiry must be 1–365 days');
      expiresAt = new Date(Date.now() + n * 864e5).toISOString();
    }
    const options = reportOptions(b.options || {});
    await buildReport(db, req.params.id, options, req.user); // scan exists and is done
    const token = 'shs_' + crypto.randomBytes(24).toString('base64url');
    const row = await db.get(
      `INSERT INTO shares (scan_id, token_hash, token_hint, mode, pass_hash, options, expires_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?::jsonb, ?, ?) RETURNING *`,
      Number(req.params.id), sha256(token), `shs_…${token.slice(-4)}`, mode, passHash, JSON.stringify(options), expiresAt, req.user.username,
    );
    res.status(201).json({ share: shareView(row, `${await getServerUrl(db)}/s/${token}`) });
  }));

  r.get('/scans/:id/shares', sharers, ah(async (req, res) => {
    const id = Number(req.params.id);
    const pid = Number.isInteger(id) ? await projectOfScan(db, id) : null;
    if (pid === null) throw notFound('Scan not found');
    await assertProject(db, req.user, pid, 'Scan not found');
    res.json((await db.all('SELECT * FROM shares WHERE scan_id = ? ORDER BY id DESC', id)).map((s) => shareView(s)));
  }));

  r.delete('/shares/:id', sharers, ah(async (req, res) => {
    const id = Number(req.params.id);
    const s = Number.isInteger(id) && await db.get('SELECT id, scan_id FROM shares WHERE id = ?', id);
    if (!s) throw notFound('Link not found');
    await assertProject(db, req.user, await projectOfScan(db, s.scan_id), 'Link not found');
    await db.run('UPDATE shares SET revoked = 1 WHERE id = ?', id);
    res.json({ ok: true });
  }));

  return r;
}

/** Public routes for share links (no session needed for password links) */
export function publicShareRoutes({ db }) {
  const r = express.Router();
  const fails = new Map();

  const sign = (secret, share, exp) => crypto.createHmac('sha256', secret).update(`${share.id}.${exp}.${share.token_hash}`).digest('base64url');
  const cookieName = (share) => `sh_share_${share.id}`;

  async function loadShare(token) {
    const s = token && token.startsWith('shs_') ? await db.get('SELECT * FROM shares WHERE token_hash = ?', sha256(token)) : null;
    if (!s || s.revoked) throw new HttpError(404, 'Link not found or revoked');
    if (s.expires_at && s.expires_at < nowIso()) throw new HttpError(410, 'This link has expired');
    return s;
  }

  async function unlocked(req, share) {
    const v = parseCookies(req.headers.cookie)[cookieName(share)];
    if (!v) return false;
    const [exp, sig] = v.split('.');
    if (!exp || !sig || Number(exp) < Date.now()) return false;
    const expected = sign(await shareSecret(db), share, exp);
    const a = Buffer.from(sig), b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  r.get('/:token', ah(async (req, res) => {
    const share = await loadShare(req.params.token);
    if (share.mode === 'internal') {
      const user = await sessionUser(db, req);
      if (!user) throw new HttpError(401, 'Sign in to view this report', { code: 'LOGIN_REQUIRED' });
      if (!(await canSeeProject(db, user, await projectOfScan(db, share.scan_id)))) {
        throw new HttpError(403, 'This account has no access to the project of this report', { code: 'NO_ACCESS' });
      }
    } else if (!(await unlocked(req, share))) {
      throw new HttpError(401, 'Enter the password to view this report', { code: 'PASSWORD_REQUIRED' });
    }
    const report = await buildReport(db, share.scan_id, share.options);
    await db.run('UPDATE shares SET views = views + 1, last_viewed_at = now() WHERE id = ?', share.id);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ report, mode: share.mode });
  }));

  r.post('/:token/unlock', ah(async (req, res) => {
    const share = await loadShare(req.params.token);
    if (share.mode !== 'password') throw bad('This link does not use a password');
    const key = `${share.id}|${req.ip}`;
    const now = Date.now();
    const recent = (fails.get(key) || []).filter((t) => now - t < FAIL_WINDOW_MS);
    if (recent.length >= MAX_FAILS) throw new HttpError(429, 'Too many wrong passwords. Wait 15 minutes and try again');
    if (!(await verifyPassword(String(req.body?.password || ''), share.pass_hash))) {
      recent.push(now);
      fails.set(key, recent);
      throw new HttpError(401, 'Wrong password');
    }
    fails.delete(key);
    const exp = String(now + UNLOCK_HOURS * 3600 * 1000);
    const value = `${exp}.${sign(await shareSecret(db), share, exp)}`;
    appendCookie(res, `${cookieName(share)}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${UNLOCK_HOURS * 3600}${req.secure ? '; Secure' : ''}`);
    res.json({ ok: true });
  }));

  // keep the map small
  setInterval(() => {
    const now = Date.now();
    for (const [k, list] of fails) if (!list.some((t) => now - t < FAIL_WINDOW_MS)) fails.delete(k);
  }, FAIL_WINDOW_MS).unref();

  return r;
}
