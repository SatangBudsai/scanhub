import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { HttpError, nowIso } from './util.js';

// ADMIN: everything. MAINTAINER: projects, repos, CI. ANALYST: scan and share. VIEWER: read only.
export const ROLES = ['ADMIN', 'MAINTAINER', 'ANALYST', 'VIEWER'];
// Role names before 1.1, still accepted by the API
const LEGACY_ROLES = { SA: 'MAINTAINER', QA: 'ANALYST', DEVELOPER: 'VIEWER' };
export const normalizeRole = (r) => { const s = String(r ?? '').trim().toUpperCase(); return LEGACY_ROLES[s] || s; };
const SESSION_DAYS = 7;
export const COOKIE = 'sh_session';
const scrypt = promisify(crypto.scrypt);
const SCRYPT = { N: 16384, r: 8, p: 1 };

export async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(String(pw), salt, 64, SCRYPT);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(pw, stored) {
  const [kind, saltB64, hashB64] = String(stored || '').split('$');
  if (kind !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const got = await scrypt(String(pw), Buffer.from(saltB64, 'base64'), expected.length, SCRYPT);
  return crypto.timingSafeEqual(expected, got);
}

export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

export function newRepoToken() {
  const token = 'shr_' + crypto.randomBytes(32).toString('base64url');
  return { token, hash: sha256(token), hint: `shr_…${token.slice(-4)}` };
}

export function publicUser(u) {
  return { id: u.id, username: u.username, role: u.role, mustChange: !!u.must_change, fromEnv: !!u.from_env };
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) {
      try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* bad cookie */ }
    }
  }
  return out;
}

export function appendCookie(res, cookie) {
  const prev = res.getHeader('Set-Cookie');
  res.setHeader('Set-Cookie', prev ? [].concat(prev, cookie) : cookie);
}

export async function createSession(db, userId, res, secure) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + SESSION_DAYS * 864e5);
  await db.run('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)', sha256(token), userId, expires.toISOString());
  appendCookie(res, `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure ? '; Secure' : ''}`);
}

export async function clearSession(db, req, res) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (token) await db.run('DELETE FROM sessions WHERE token_hash = ?', sha256(token));
  appendCookie(res, `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

export async function sessionUser(db, req) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (!token) return null;
  const row = await db.get(
    'SELECT u.*, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?',
    sha256(token),
  );
  if (!row) return null;
  if (row.expires_at < nowIso() || !row.active) {
    await db.run('DELETE FROM sessions WHERE token_hash = ?', sha256(token));
    return null;
  }
  return row;
}

// Logged in. Unless allowMustChange, users with a temporary password are blocked until they change it.
export const requireAuth = (db, { allowMustChange = false } = {}) => (req, res, next) => {
  sessionUser(db, req).then((u) => {
    if (!u) return next(new HttpError(401, 'Not signed in'));
    if (u.must_change && !allowMustChange) {
      return next(new HttpError(403, 'Change your temporary password first', { code: 'MUST_CHANGE_PASSWORD' }));
    }
    req.user = u;
    next();
  }, next);
};

export const requireRole = (...roles) => (req, res, next) => {
  if (!req.user || !roles.includes(req.user.role)) return next(new HttpError(403, 'You do not have permission to do this'));
  next();
};

// Re-apply the admin account from env. Runs on every start.
export async function upsertEnvAdmin(db, username, password) {
  const existing = await db.get('SELECT * FROM users WHERE username = ?', username);
  const samePassword = existing ? await verifyPassword(password, existing.pass_hash) : false;
  const hash = samePassword ? existing.pass_hash : await hashPassword(password);
  await db.tx(async (q) => {
    await q.run('UPDATE users SET from_env = 0, active = 0 WHERE from_env = 1 AND username <> ?', username);
    if (existing) {
      await q.run('UPDATE users SET pass_hash = ?, role = ?, active = 1, from_env = 1, must_change = 0 WHERE id = ?', hash, 'ADMIN', existing.id);
      if (!samePassword) await q.run('DELETE FROM sessions WHERE user_id = ?', existing.id);
    } else {
      await q.run(
        'INSERT INTO users (username, pass_hash, role, active, must_change, from_env) VALUES (?, ?, ?, 1, 0, 1)',
        username, hash, 'ADMIN',
      );
    }
  });
}
