// SonarQube auto-setup for the server bundled in docker-compose.yml.
// When SONAR_URL is set without SONAR_TOKEN, ScanHub waits for SonarQube, replaces the default
// admin/admin password with a random one (or SONAR_ADMIN_PASSWORD), creates a user token and keeps
// both encrypted in the settings key `sonarAuto`. Every step is safe to repeat on each start.
import crypto from 'node:crypto';
import { config } from './config.js';
import { decrypt, encrypt } from './secrets.js';

export const SONAR_AUTO_KEY = 'sonarAuto';
export const SONAR_TOKEN_NAME = 'scanhub';
export const SONAR_STARTING_NOTE = 'SonarQube skipped: the bundled SonarQube server is still starting, it will be used once it is ready';

// Shared with settings/runner: { state: 'waiting' | 'configuring' | 'ready' | 'error', message }
const status = { state: 'waiting', message: 'Waiting for SonarQube to start' };
export const sonarAutoStatus = () => ({ ...status });
const setStatus = (state, message) => Object.assign(status, { state, message });

/** Password that passes SonarQube's rules (12+ chars, upper, lower, digit, special) */
export const randomSonarPassword = () => `${crypto.randomBytes(18).toString('base64url')}aA1!`;

const basic = (user, pass = '') => 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
const realCrypt = { encrypt, decrypt };

export class FatalSetupError extends Error {}

/**
 * One setup attempt. Returns the token. Throws FatalSetupError when retrying cannot help,
 * any other error for transient problems (server not up yet, network).
 */
export async function setupSonarOnce({ db, url, fetchFn = fetch, crypt = realCrypt, envPassword = '', log = () => {} }) {
  const call = async (method, p, auth, form) => {
    const res = await fetchFn(url + p, {
      method,
      headers: { ...(auth ? { Authorization: auth } : {}), ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
      body: form ? new URLSearchParams(form).toString() : undefined,
      signal: AbortSignal.timeout(15000),
    });
    let body = null;
    try { body = await res.json(); } catch { /* empty or non-JSON */ }
    return { ok: res.ok, status: res.status, body };
  };
  const valid = async (auth) => {
    const r = await call('GET', '/api/authentication/validate', auth);
    return r.ok && r.body?.valid === true;
  };

  const st = await call('GET', '/api/system/status');
  if (!st.ok || st.body?.status !== 'UP') {
    throw new Error(`SonarQube is not ready yet (${st.body?.status || `HTTP ${st.status}`})`);
  }

  const saved = (await db.getSetting(SONAR_AUTO_KEY, null)) || {};
  const open = async (v) => { try { return v ? await crypt.decrypt(db, v) : ''; } catch { return ''; } };
  const save = async (patch) => {
    const cur = (await db.getSetting(SONAR_AUTO_KEY, null)) || {};
    await db.setSetting(SONAR_AUTO_KEY, { ...cur, ...patch, url });
  };

  // 1. A token from an earlier start that still works: nothing to do
  const oldToken = await open(saved.token);
  if (oldToken && (await valid(basic(oldToken)))) return oldToken;

  // 2. Admin password: env wins, then the one we stored; generate and store one before using it,
  //    so a crash between "change password" and "save" can never lock us out
  let stored = await open(saved.password);
  const target = envPassword || stored || randomSonarPassword();
  if (!envPassword && !stored) {
    await save({ password: await crypt.encrypt(db, target) });
    stored = target;
  }

  let current = null;
  for (const p of [...new Set([target, stored, 'admin'].filter(Boolean))]) {
    if (await valid(basic('admin', p))) { current = p; break; }
  }
  if (!current) {
    throw new FatalSetupError('cannot log in to SonarQube as admin (the password was changed outside ScanHub). Set SONAR_ADMIN_PASSWORD to the admin password, or set SONAR_TOKEN');
  }
  if (current !== target) {
    const r = await call('POST', '/api/users/change_password', basic('admin', current), { login: 'admin', previousPassword: current, password: target });
    if (!r.ok) throw new FatalSetupError(`SonarQube refused the new admin password (HTTP ${r.status}${r.body?.errors?.[0]?.msg ? `: ${r.body.errors[0].msg}` : ''})`);
    log(current === 'admin' ? 'replaced the default admin/admin password' : 'updated the admin password');
  }
  if (target !== stored) await save({ password: await crypt.encrypt(db, target) });

  // 3. Fresh user token. Token names are unique per user, so drop our old one first (ignore "not found")
  const admin = basic('admin', target);
  await call('POST', '/api/user_tokens/revoke', admin, { login: 'admin', name: SONAR_TOKEN_NAME });
  const g = await call('POST', '/api/user_tokens/generate', admin, { login: 'admin', name: SONAR_TOKEN_NAME });
  if (!g.ok || !g.body?.token) throw new Error(`SonarQube did not create a token (HTTP ${g.status})`);
  await save({ token: await crypt.encrypt(db, g.body.token), createdAt: new Date().toISOString() });
  log('created the ScanHub token');
  return g.body.token;
}

/** Background loop: retries until SonarQube is ready, stops on a fatal error. Never throws. */
export async function runSonarAutoSetup({
  db, url = config.sonarUrl, envPassword = config.sonarAdminPassword, fetchFn = fetch, crypt = realCrypt,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)), maxAttempts = Infinity, log = (m) => console.log(`[sonarqube] ${m}`),
}) {
  let lastMsg = '';
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      setStatus(attempt === 1 ? 'waiting' : status.state, status.message);
      await setupSonarOnce({ db, url, fetchFn, crypt, envPassword, log });
      setStatus('ready', 'Connected to the bundled SonarQube');
      log(`ready at ${url}`);
      return true;
    } catch (e) {
      if (e instanceof FatalSetupError) {
        setStatus('error', `SonarQube auto-setup stopped: ${e.message}`);
        log(`auto-setup stopped: ${e.message}`);
        return false;
      }
      const msg = e.cause?.code ? `${e.message} (${e.cause.code})` : e.message;
      setStatus('waiting', 'Waiting for SonarQube to start');
      if (msg !== lastMsg) log(`waiting: ${msg}`);
      lastMsg = msg;
      await sleep(Math.min(60000, 5000 * attempt));
    }
  }
  return false;
}

/** Token from the auto-setup, or '' while it is not done */
export async function sonarAutoToken(db, crypt = realCrypt) {
  const s = await db.getSetting(SONAR_AUTO_KEY, null);
  if (!s?.token) return '';
  try { return await crypt.decrypt(db, s.token); } catch { return ''; }
}
