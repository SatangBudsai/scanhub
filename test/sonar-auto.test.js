// SonarQube auto-setup against a fake SonarQube Web API (mocked fetch, in-memory settings)
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { setupSonarOnce, runSonarAutoSetup, sonarAutoStatus, sonarAutoToken, randomSonarPassword, FatalSetupError, SONAR_AUTO_KEY } = await import('../server/sonar-auto.js');

const URL_ = 'http://sonarqube:9000';
const crypt = { encrypt: async (_db, v) => `enc:${v}`, decrypt: async (_db, v) => String(v).replace(/^enc:/, '') };

function memDb(init = {}) {
  const m = new Map(Object.entries(init));
  return { m, getSetting: async (k, d = null) => (m.has(k) ? m.get(k) : d), setSetting: async (k, v) => { m.set(k, v); } };
}

/** Fake SonarQube: status, basic auth for admin + tokens, change_password, user_tokens */
function fakeSonar({ status = 'UP', password = 'admin', down = 0 } = {}) {
  const s = { status, password, tokens: new Map(), calls: [], down, n: 0 };
  s.fetch = async (u, opts = {}) => {
    const p = new URL(u);
    s.calls.push(`${opts.method || 'GET'} ${p.pathname}`);
    if (s.down > 0) { s.down--; throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); }
    const json = (code, body) => new Response(body === undefined ? null : JSON.stringify(body), { status: code });
    if (p.pathname === '/api/system/status') return json(200, { status: s.status });
    const [user, pass] = Buffer.from(String(opts.headers?.Authorization || '').replace(/^Basic /, ''), 'base64').toString().split(':');
    const isAdmin = user === 'admin' && pass === s.password;
    const isToken = !pass && [...s.tokens.values()].includes(user);
    if (p.pathname === '/api/authentication/validate') return json(200, { valid: isAdmin || isToken });
    if (!isAdmin) return json(401);
    const form = new URLSearchParams(opts.body || '');
    if (p.pathname === '/api/users/change_password') {
      if (form.get('previousPassword') !== s.password) return json(400, { errors: [{ msg: 'wrong' }] });
      s.password = form.get('password');
      return json(204);
    }
    if (p.pathname === '/api/user_tokens/revoke') { s.tokens.delete(form.get('name')); return json(204); }
    if (p.pathname === '/api/user_tokens/generate') {
      if (s.tokens.has(form.get('name'))) return json(400, { errors: [{ msg: 'exists' }] });
      const t = `squ_${++s.n}`;
      s.tokens.set(form.get('name'), t);
      return json(200, { login: 'admin', name: form.get('name'), token: t });
    }
    return json(404);
  };
  return s;
}

test('random password meets SonarQube rules', () => {
  const p = randomSonarPassword();
  assert.ok(p.length >= 12 && /[a-z]/.test(p) && /[A-Z]/.test(p) && /\d/.test(p) && /[^a-zA-Z0-9]/.test(p));
  assert.notEqual(p, randomSonarPassword());
});

test('fresh SonarQube: replaces admin/admin, stores password and token', async () => {
  const sq = fakeSonar();
  const db = memDb();
  const token = await setupSonarOnce({ db, url: URL_, fetchFn: sq.fetch, crypt });
  assert.equal(token, 'squ_1');
  assert.notEqual(sq.password, 'admin');
  const saved = db.m.get(SONAR_AUTO_KEY);
  assert.equal(saved.password, `enc:${sq.password}`);
  assert.equal(saved.token, 'enc:squ_1');
  assert.equal(await sonarAutoToken(db, crypt), 'squ_1');
});

test('idempotent: a restart with a valid token changes nothing', async () => {
  const sq = fakeSonar();
  const db = memDb();
  await setupSonarOnce({ db, url: URL_, fetchFn: sq.fetch, crypt });
  const pw = sq.password;
  sq.calls.length = 0;
  assert.equal(await setupSonarOnce({ db, url: URL_, fetchFn: sq.fetch, crypt }), 'squ_1');
  assert.equal(sq.password, pw);
  assert.ok(!sq.calls.some((c) => c.startsWith('POST')), sq.calls.join());
});

test('token revoked in SonarQube: logs in with stored password and creates a new one', async () => {
  const sq = fakeSonar();
  const db = memDb();
  await setupSonarOnce({ db, url: URL_, fetchFn: sq.fetch, crypt });
  sq.tokens.clear();
  assert.equal(await setupSonarOnce({ db, url: URL_, fetchFn: sq.fetch, crypt }), 'squ_2');
  assert.equal(sq.tokens.get('scanhub'), 'squ_2');
});

test('crash after the password was saved but before the token: recovers', async () => {
  const sq = fakeSonar({ password: 'Stored-pass-123!' });
  const db = memDb({ [SONAR_AUTO_KEY]: { password: 'enc:Stored-pass-123!' } });
  assert.equal(await setupSonarOnce({ db, url: URL_, fetchFn: sq.fetch, crypt }), 'squ_1');
  assert.equal(sq.password, 'Stored-pass-123!');
});

test('SONAR_ADMIN_PASSWORD is used instead of a random one', async () => {
  const sq = fakeSonar();
  const db = memDb();
  await setupSonarOnce({ db, url: URL_, fetchFn: sq.fetch, crypt, envPassword: 'Env-pass-123456!' });
  assert.equal(sq.password, 'Env-pass-123456!');
  // already the env password on the next start (token gone): still fine
  sq.tokens.clear();
  assert.equal(await setupSonarOnce({ db, url: URL_, fetchFn: sq.fetch, crypt, envPassword: 'Env-pass-123456!' }), 'squ_2');
});

test('unknown admin password: fatal, no retry', async () => {
  const sq = fakeSonar({ password: 'someone-else-changed-it' });
  await assert.rejects(setupSonarOnce({ db: memDb(), url: URL_, fetchFn: sq.fetch, crypt }), FatalSetupError);
  const ok = await runSonarAutoSetup({ db: memDb(), url: URL_, fetchFn: sq.fetch, crypt, sleep: async () => {}, maxAttempts: 5, log: () => {} });
  assert.equal(ok, false);
  assert.equal(sonarAutoStatus().state, 'error');
});

test('waits while SonarQube is down or starting, then connects', async () => {
  const sq = fakeSonar({ status: 'STARTING', down: 2 });
  const db = memDb();
  let sleeps = 0;
  const sleep = async () => { if (++sleeps === 3) sq.status = 'UP'; };
  const ok = await runSonarAutoSetup({ db, url: URL_, fetchFn: sq.fetch, crypt, sleep, maxAttempts: 10, log: () => {} });
  assert.equal(ok, true);
  assert.equal(sleeps, 3);
  assert.equal(sonarAutoStatus().state, 'ready');
  assert.equal(await sonarAutoToken(db, crypt), 'squ_1');
});

test('no token yet: sonarAutoToken is empty', async () => {
  assert.equal(await sonarAutoToken(memDb(), crypt), '');
});
