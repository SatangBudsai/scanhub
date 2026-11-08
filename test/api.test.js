import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { testDatabase } from './helpers/pg.js';

const root = path.resolve(import.meta.dirname, '..');
const fx = (name) => JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'fixtures', name), 'utf8'));
const ADMIN_PW = 'env-admin-pass-1';

let proc, base, dataDir, pgdb, imageTools;

function startServer(env = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['server/index.js'], {
      cwd: root,
      env: {
        ...process.env, PORT: '0', DATA_DIR: dataDir, DATABASE_URL: pgdb.url, SCANHUB_IMAGE_TOOLS: imageTools,
        SONAR_URL: '', SONAR_TOKEN: '', NVD_API_KEY: '',
        SCANHUB_ADMIN_USER: 'admin', SCANHUB_ADMIN_PASSWORD: ADMIN_PW, SCANHUB_URL: 'http://scanhub.test', ...env,
      },
    });
    let out = '';
    const onData = (d) => {
      out += d;
      const m = /listening on port (\d+)/.exec(out);
      if (m) { p.stdout.off('data', onData); resolve({ p, base: `http://127.0.0.1:${m[1]}` }); }
    };
    p.stdout.on('data', onData);
    p.stderr.on('data', (d) => { out += d; });
    p.on('exit', (code) => reject(new Error(`server exited ${code}: ${out}`)));
  });
}

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scanhub-api-'));
  // a fake "built into the image" scanner: trivy, with its version in the manifest
  imageTools = path.join(dataDir, 'image-tools');
  fs.mkdirSync(path.join(imageTools, 'trivy'), { recursive: true });
  fs.writeFileSync(path.join(imageTools, 'trivy', 'trivy'), '');
  fs.writeFileSync(path.join(imageTools, 'versions.json'), JSON.stringify({ trivy: '0.99.1' }));
  pgdb = await testDatabase();
  ({ p: proc, base } = await startServer());
}, { timeout: 180000 });

after(async () => {
  proc?.kill();
  await new Promise((r) => setTimeout(r, 500));
  await pgdb?.cleanup();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

// Tiny client that keeps its own session cookie
function client() {
  let cookie = '';
  return async function call(method, url, body, headers = {}) {
    const h = { ...headers };
    if (cookie) h.Cookie = cookie;
    let payload = body;
    if (body !== undefined && !(body instanceof Buffer)) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
    const res = await fetch(base + url, { method, headers: h, body: payload });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    let data = null;
    const text = await res.text();
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data };
  };
}

const state = {};

test('health and login as the env admin', async () => {
  const anon = client();
  assert.equal((await anon('GET', '/api/health')).data.ok, true);
  assert.equal((await anon('GET', '/api/projects')).status, 401);
  assert.equal((await anon('POST', '/api/auth/login', { username: 'admin', password: 'wrong-pass' })).status, 401);
  const admin = client();
  const r = await admin('POST', '/api/auth/login', { username: 'admin', password: ADMIN_PW });
  assert.equal(r.status, 200);
  assert.deepEqual([r.data.user.role, r.data.user.fromEnv, r.data.user.mustChange], ['ADMIN', true, false]);
  const me = await admin('GET', '/api/auth/me');
  assert.equal(me.data.setupDone, false);
  assert.equal(me.data.serverUrl, 'http://scanhub.test');
  state.admin = admin;
});

test('setup, scanners and settings', async () => {
  const a = state.admin;
  const s = await a('GET', '/api/setup');
  assert.equal(s.data.catalog.length, 7);
  assert.equal((await a('POST', '/api/setup', { tools: ['nope'] })).status, 400);
  assert.equal((await a('POST', '/api/setup', { tools: [], schedule: { enabled: true, time: '03:30', updateDb: true } })).status, 200);
  assert.equal((await a('GET', '/api/auth/me')).data.setupDone, true);

  // setup only enables / disables; tools built into the image are installed already
  assert.equal((await a('POST', '/api/setup', { tools: ['trivy'], schedule: { enabled: true, time: '03:30', updateDb: true } })).status, 200);
  let tools = (await a('GET', '/api/tools')).data;
  for (let i = 0; i < 20 && tools.find((t) => t.id === 'trivy').imageVersion === null; i++) {
    await new Promise((r) => setTimeout(r, 250));
    tools = (await a('GET', '/api/tools')).data;
  }
  assert.equal(tools.length, 7);
  const trivy = tools.find((t) => t.id === 'trivy');
  assert.deepEqual([trivy.installed, trivy.enabled, trivy.source, trivy.imageVersion, trivy.version], [true, true, 'image', '0.99.1', '0.99.1']);
  const grype = tools.find((t) => t.id === 'grype');
  assert.deepEqual([grype.installed, grype.enabled], [false, false]);
  assert.equal(tools.find((t) => t.id === 'sonarqube').configured, false);
  assert.equal((await a('POST', '/api/tools/trivy/disable')).status, 200);
  assert.equal((await a('GET', '/api/tools')).data.find((t) => t.id === 'trivy').enabled, false);
  assert.equal((await a('POST', '/api/tools/trivy/enable')).status, 200);
  assert.equal((await a('GET', '/api/tools')).data.find((t) => t.id === 'trivy').enabled, true);
  assert.equal((await a('POST', '/api/tools/nope/enable')).status, 404);
  // reset with no override keeps the built-in version
  assert.equal((await a('POST', '/api/tools/trivy/reset')).status, 200);
  await new Promise((r) => setTimeout(r, 300));
  const afterReset = (await a('GET', '/api/tools')).data.find((t) => t.id === 'trivy');
  assert.deepEqual([afterReset.installed, afterReset.source, afterReset.status], [true, 'image', 'idle']);

  assert.equal((await a('PUT', '/api/settings', { scanTime: '25:00' })).status, 400);
  const put = await a('PUT', '/api/settings', { sonar: { url: 'https://sonar.example/', token: 'squ_abc' }, retentionDays: 30, schedule: { time: '04:00' } });
  assert.equal(put.status, 200);
  assert.deepEqual(put.data.sonar, { url: 'https://sonar.example', tokenSet: true, fromEnv: false });
  assert.equal(put.data.nvdFromEnv, false);
  assert.equal(put.data.schedule.time, '04:00');
  assert.equal(put.data.schedule.enabled, true);
  assert.equal(put.data.retentionDays, 30);
  assert.equal((await a('GET', '/api/tools')).data.find((t) => t.id === 'sonarqube').configured, true);
  // empty token keeps it, null clears it
  assert.equal((await a('PUT', '/api/settings', { sonar: { token: '' } })).data.sonar.tokenSet, true);
  assert.equal((await a('PUT', '/api/settings', { sonar: { token: null } })).data.sonar.tokenSet, false);
  assert.ok(Array.isArray((await a('GET', '/api/tools/log')).data));
});

test('projects and repos', async () => {
  const a = state.admin;
  const p = await a('POST', '/api/projects', { name: 'Payment Platform' });
  assert.equal(p.status, 201);
  const r = await a('POST', '/api/repos', { projectId: p.data.id, name: 'payment-api', lang: 'Go', branch: 'main' });
  assert.equal(r.status, 201);
  assert.match(r.data.token, /^shr_/);
  assert.equal(r.data.repo.tokenHint, `shr_…${r.data.token.slice(-4)}`);
  assert.equal((await a('POST', '/api/repos', { projectId: p.data.id, name: 'payment-api' })).status, 409);
  assert.equal((await a('POST', '/api/repos', { projectId: p.data.id, name: 'Bad Name!' })).status, 400);
  const list = (await a('GET', '/api/projects')).data;
  assert.equal(list[0].repos[0].lastScan, null);
  assert.equal((await a('POST', `/api/repos/${r.data.repo.id}/scan`, {})).status, 400, 'no git url');
  assert.equal((await a('DELETE', `/api/projects/${p.data.id}`)).status, 409);
  Object.assign(state, { projectId: p.data.id, repoId: r.data.repo.id, token: r.data.token });
});

const ci = (token, url, body) => fetch(base + url, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': body instanceof Buffer ? 'application/gzip' : 'application/json' },
  body: body instanceof Buffer ? body : JSON.stringify(body),
}).then(async (res) => ({ status: res.status, data: await res.json() }));

test('CI reports: merged findings, new / fixed and the gate', async () => {
  const { token } = state;
  assert.equal((await ci('shr_wrong', '/api/v1/reports', { reports: [] })).status, 401);
  assert.equal((await ci(token, '/api/v1/reports', { reports: [{ tool: 'unknown', data: {} }] })).status, 400);

  const reports1 = [
    { tool: 'trivy', data: fx('trivy.json') },
    { tool: 'gitleaks', data: fx('gitleaks.json') },
    { tool: 'semgrep', data: fx('semgrep.json') },
  ];
  const r1 = await ci(token, '/api/v1/reports', { branch: 'main', commit: 'a91f3c2', reports: reports1 });
  assert.equal(r1.status, 422, 'the default gate blocks new critical / high');
  assert.deepEqual([r1.data.gate.mode, r1.data.gate.scope, r1.data.gate.severities], ['block', 'new', ['critical', 'high']]);
  assert.equal(r1.data.num, 1);
  assert.equal(r1.data.status, 'done');
  // trivy 4 + semgrep sqli + semgrep smell; the secret from 3 tools is one finding
  assert.equal(r1.data.newCount, 6);
  assert.deepEqual(r1.data.counts, [3, 2, 0, 1, 0]);
  assert.equal(r1.data.url, `http://scanhub.test/#repo/${state.repoId}/1`);

  const detail1 = await state.admin('GET', `/api/scans/${r1.data.scanId}`);
  const secret = detail1.data.findings.find((f) => f.category === 'Secret');
  assert.deepEqual(secret.tools.sort(), ['gitleaks', 'semgrep', 'trivy']);
  assert.ok(!JSON.stringify(detail1.data).includes('AKIAZ7Q3EXAMPLE4KEY9'));
  assert.equal(detail1.data.runs.length, 3);
  assert.equal(detail1.data.prev, null);

  // second scan: one fixed, one new high
  const t2 = fx('trivy.json');
  t2.Results[0].Vulnerabilities = t2.Results[0].Vulnerabilities.filter((v) => v.VulnerabilityID !== 'CVE-2023-44487');
  t2.Results[0].Vulnerabilities.push({ VulnerabilityID: 'CVE-2024-45338', PkgName: 'golang.org/x/net', InstalledVersion: 'v0.15.0', FixedVersion: '0.33.0', Severity: 'HIGH', Title: 'Non-linear parsing of case-insensitive content' });
  const reports2 = [{ tool: 'trivy', data: t2 }, reports1[1], reports1[2]];
  const r2 = await ci(token, '/api/v1/reports?fail_on=critical,high', { branch: 'main', commit: 'b22c0de', reports: reports2 });
  assert.equal(r2.status, 422, 'new high fails the gate');
  assert.equal(r2.data.gate.failed, true);
  assert.equal(r2.data.newCount, 1);
  assert.equal(r2.data.fixedCount, 1);
  assert.equal(r2.data.newBySeverity.high, 1);

  const detail2 = await state.admin('GET', `/api/scans/${r2.data.scanId}`);
  assert.deepEqual(detail2.data.prev, { id: r1.data.scanId, num: 1, refType: 'branch', branch: 'main' });
  const fixed = detail2.data.findings.filter((f) => f.status === 'fixed');
  assert.equal(fixed.length, 1);
  assert.equal(fixed[0].rules[0].id, 'CVE-2023-44487');
  const existing = detail2.data.findings.find((f) => f.category === 'Secret');
  assert.deepEqual([existing.status, existing.firstSeenNum], ['existing', 1]);

  // third scan with nothing new passes the gate
  const r3 = await ci(token, '/api/v1/reports?fail_on=critical,high', { reports: reports2 });
  assert.equal(r3.status, 200);
  assert.equal(r3.data.newCount, 0);
  assert.equal(r3.data.gate.failed, false);

  const scans = (await state.admin('GET', `/api/repos/${state.repoId}/scans`)).data;
  assert.deepEqual(scans.map((s) => s.num), [3, 2, 1]);
  assert.equal(scans[0].trigger, 'upload');
  const status = await fetch(`${base}/api/v1/scans/${r3.data.scanId}`, { headers: { Authorization: `Bearer ${token}` } }).then((r) => r.json());
  assert.equal(status.status, 'done');
  const projects = (await state.admin('GET', '/api/projects')).data;
  assert.equal(projects[0].repos[0].lastScan.num, 3);
  Object.assign(state, { scan1: r1.data.scanId, scan2: r2.data.scanId });
});

test('report export: filters, no ids, no secrets', async () => {
  const a = state.admin;
  const full = await a('GET', `/api/scans/${state.scan2}/report`);
  assert.equal(full.status, 200);
  const rep = full.data;
  assert.equal(rep.title, 'รายงานผลการสแกนความปลอดภัย · payment-api');
  assert.deepEqual(rep.repo, { name: 'payment-api', projectName: 'Payment Platform', lang: 'Go', branch: 'main' });
  assert.equal(rep.scan.num, 2);
  assert.deepEqual(rep.prev, { num: 1 });
  assert.equal(rep.summary.newBySeverity.high, 1);
  assert.deepEqual(rep.options, { title: '', preparedFor: '', minSeverity: 'low', includeFixed: false, includeSnippets: true });
  assert.ok(rep.findings.every((f) => f.status !== 'fixed' && !('id' in f)));
  assert.ok(!JSON.stringify(rep).includes('AKIAZ7Q3EXAMPLE4KEY9'));
  // within a severity, new findings come first
  const highs = rep.findings.filter((f) => f.severity === 'high');
  assert.equal(highs[0].status, 'new');

  const q = await a('GET', `/api/scans/${state.scan2}/report?minSeverity=high&includeFixed=true&includeSnippets=false&title=Q4%20review&preparedFor=ACME`);
  assert.ok(q.data.findings.every((f) => ['critical', 'high'].includes(f.severity) && f.snippet === null));
  assert.ok(q.data.findings.some((f) => f.status === 'fixed'));
  assert.equal(q.data.title, 'Q4 review');
  assert.equal(q.data.preparedFor, 'ACME');

  // a failed scan has no report
  const failed = (await a('GET', `/api/repos/${state.repoId}/scans`)).data.find((s) => s.status === 'failed');
  if (failed) assert.equal((await a('GET', `/api/scans/${failed.id}/report`)).status, 409);
  assert.equal((await a('GET', '/api/scans/999999/report')).status, 404);
});

test('share links: internal, password, expiry, revoke, rate limit', async () => {
  const a = state.admin;
  const anon = client();
  const tokenOf = (url) => url.split('/s/')[1];

  assert.equal((await a('POST', `/api/scans/${state.scan2}/shares`, { mode: 'password', password: 'short' })).status, 400);
  assert.equal((await a('POST', `/api/scans/${state.scan2}/shares`, { mode: 'internal', expiresInDays: 0 })).status, 400);
  assert.equal((await a('POST', `/api/scans/${state.scan2}/shares`, { mode: 'public' })).status, 400);

  // internal link: needs a session
  const internal = await a('POST', `/api/scans/${state.scan2}/shares`, { mode: 'internal', expiresInDays: 30, options: { minSeverity: 'critical', preparedFor: 'ACME' } });
  assert.equal(internal.status, 201);
  assert.match(internal.data.share.url, /^http:\/\/scanhub\.test\/s\/shs_[A-Za-z0-9_-]{32}$/);
  assert.equal(internal.data.share.createdBy, 'admin');
  assert.ok(internal.data.share.expiresAt);
  const tIn = tokenOf(internal.data.share.url);
  const needLogin = await anon('GET', `/api/share/${tIn}`);
  assert.deepEqual([needLogin.status, needLogin.data.code], [401, 'LOGIN_REQUIRED']);
  const viewIn = await a('GET', `/api/share/${tIn}`);
  assert.equal(viewIn.status, 200);
  assert.equal(viewIn.data.mode, 'internal');
  assert.ok(viewIn.data.report.findings.every((f) => f.severity === 'critical'));
  assert.equal(viewIn.data.report.preparedFor, 'ACME');

  const list = (await a('GET', `/api/scans/${state.scan2}/shares`)).data;
  assert.equal(list[0].url, null);
  assert.equal(list[0].tokenHint, `shs_…${tIn.slice(-4)}`);
  assert.equal(list[0].views, 1);
  assert.ok(list[0].lastViewedAt);

  // the viewer page is report.html, never the SPA
  const page = await fetch(`${base}/s/${tIn}`);
  const html = await page.text();
  const index = fs.existsSync(path.join(root, 'public', 'index.html')) ? fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8') : null;
  assert.notEqual(html, index);
  if (fs.existsSync(path.join(root, 'public', 'report.html'))) assert.equal(page.status, 200);
  else assert.equal(page.status, 404);

  // password link
  const pw = await a('POST', `/api/scans/${state.scan2}/shares`, { mode: 'password', password: 'customer-pass-1', expiresInDays: null });
  const tPw = tokenOf(pw.data.share.url);
  assert.equal(pw.data.share.expiresAt, null);
  const needPw = await anon('GET', `/api/share/${tPw}`);
  assert.deepEqual([needPw.status, needPw.data.code], [401, 'PASSWORD_REQUIRED']);
  assert.equal((await anon('POST', `/api/share/${tPw}/unlock`, { password: 'wrong-pass-1' })).status, 401);
  const unlock = await anon('POST', `/api/share/${tPw}/unlock`, { password: 'customer-pass-1' });
  assert.equal(unlock.status, 200);
  const viewPw = await anon('GET', `/api/share/${tPw}`);
  assert.equal(viewPw.status, 200);
  assert.equal(viewPw.data.mode, 'password');
  // a forged cookie does not work
  const forged = await fetch(`${base}/api/share/${tPw}`, { headers: { Cookie: `sh_share_${pw.data.share.id}=${Date.now() + 1e7}.forged` } });
  assert.equal(forged.status, 401);

  // rate limit: 5 wrong attempts per share per IP, then 429 even with the right password
  const pw2 = await a('POST', `/api/scans/${state.scan2}/shares`, { mode: 'password', password: 'customer-pass-2' });
  const tPw2 = tokenOf(pw2.data.share.url);
  const other = client();
  for (let i = 0; i < 5; i++) assert.equal((await other('POST', `/api/share/${tPw2}/unlock`, { password: `nope-${i}-xxxx` })).status, 401);
  assert.equal((await other('POST', `/api/share/${tPw2}/unlock`, { password: 'customer-pass-2' })).status, 429);

  // internal links need project access; VIEWER can view the report but not create links
  const dev = await a('POST', '/api/users', { username: 'dev.viewer', password: 'temp-pass-9', role: 'VIEWER' });
  const devc = client();
  await devc('POST', '/api/auth/login', { username: 'dev.viewer', password: 'temp-pass-9' });
  await devc('POST', '/api/auth/change-password', { current: 'temp-pass-9', newPassword: 'dev-pass-123' });
  const noAccess = await devc('GET', `/api/share/${tIn}`);
  assert.deepEqual([noAccess.status, noAccess.data.code], [403, 'NO_ACCESS']);
  assert.equal((await devc('GET', `/api/scans/${state.scan2}/report`)).status, 404);
  await a('PATCH', `/api/users/${dev.data.id}`, { projectIds: [state.projectId] });
  assert.equal((await devc('GET', `/api/scans/${state.scan2}/report`)).status, 200);
  assert.equal((await devc('POST', `/api/scans/${state.scan2}/shares`, { mode: 'internal' })).status, 403);
  assert.equal((await devc('GET', `/api/share/${tIn}`)).status, 200);

  // expired -> 410
  await pgdb.query(`UPDATE shares SET expires_at = now() - interval '1 minute' WHERE id = $1`, [internal.data.share.id]);
  assert.equal((await a('GET', `/api/share/${tIn}`)).status, 410);

  // revoked -> 404 immediately, unknown -> 404
  assert.equal((await a('DELETE', `/api/shares/${pw.data.share.id}`)).status, 200);
  assert.equal((await anon('GET', `/api/share/${tPw}`)).status, 404);
  assert.equal((await anon('GET', '/api/share/shs_doesnotexist')).status, 404);
  assert.equal((await a('GET', `/api/scans/${state.scan2}/shares`)).data.find((s) => s.id === pw.data.share.id).revoked, true);
});

test('CI gate: block / report, scope new / open, per-call overrides, text summary', async () => {
  const a = state.admin;
  assert.equal((await a('POST', '/api/repos', { projectId: state.projectId, name: 'gate-repo', gate: { mode: 'stop' } })).status, 400);
  assert.equal((await a('POST', '/api/repos', { projectId: state.projectId, name: 'gate-repo', gate: { severities: [] } })).status, 400);
  const def = await a('POST', '/api/repos', { projectId: state.projectId, name: 'gate-default' });
  assert.deepEqual(def.data.repo.gate, { mode: 'block', severities: ['critical', 'high'], scope: 'new' });
  const g = await a('POST', '/api/repos', { projectId: state.projectId, name: 'gate-repo', gate: { severities: ['critical'] } });
  assert.deepEqual(g.data.repo.gate, { mode: 'block', severities: ['critical'], scope: 'new' });
  const tok = g.data.token;
  const rid = g.data.repo.id;
  const trivy = { reports: [{ tool: 'trivy', data: fx('trivy.json') }] };

  // block, scope new: 2 new criticals (highs are not in the gate)
  const s1 = await ci(tok, '/api/v1/reports', trivy);
  assert.equal(s1.status, 422);
  assert.deepEqual(s1.data.gate.matched, { critical: 2, high: 0, medium: 0, low: 0, info: 0 });
  assert.equal(s1.data.gate.failed, true);
  assert.match(s1.data.gate.reason, /Critical 2/);
  assert.match(s1.data.summaryText, /ไม่ผ่าน/);
  assert.ok(s1.data.summaryText.includes(s1.data.url));

  // same findings again: nothing new -> passes
  const s2 = await ci(tok, '/api/v1/reports', trivy);
  assert.equal(s2.status, 200);
  assert.equal(s2.data.gate.failed, false);
  assert.match(s2.data.summaryText, /ผ่าน/);

  // scope open: the open criticals block again
  assert.deepEqual((await a('PATCH', `/api/repos/${rid}`, { gate: { scope: 'open' } })).data.gate, { mode: 'block', severities: ['critical'], scope: 'open' });
  const s3 = await ci(tok, '/api/v1/reports', trivy);
  assert.equal(s3.status, 422);
  assert.equal(s3.data.gate.matched.critical, 2);

  // gate=report for one call: always 200 but still says what matched
  const s4 = await ci(tok, '/api/v1/reports?gate=report', trivy);
  assert.equal(s4.status, 200);
  assert.deepEqual([s4.data.gate.mode, s4.data.gate.failed, s4.data.gate.matched.critical], ['report', false, 2]);
  assert.match(s4.data.gate.reason, /รายงานอย่างเดียว/);

  // report mode on the repo: 200
  await a('PATCH', `/api/repos/${rid}`, { gate: { mode: 'report' } });
  assert.equal((await ci(tok, '/api/v1/reports', trivy)).status, 200);

  // fail_on (compatibility) overrides for one call: blocks on NEW findings at those severities, even in report mode
  assert.equal((await ci(tok, '/api/v1/reports?fail_on=critical', trivy)).status, 200, 'nothing new');
  const t2 = fx('trivy.json');
  t2.Results[0].Vulnerabilities.push({ VulnerabilityID: 'CVE-2099-0001', PkgName: 'example.com/new', InstalledVersion: '1.0.0', Severity: 'CRITICAL', Title: 'new critical' });
  const s6 = await ci(tok, '/api/v1/reports?fail_on=critical', { reports: [{ tool: 'trivy', data: t2 }] });
  assert.equal(s6.status, 422);
  assert.deepEqual([s6.data.gate.mode, s6.data.gate.scope, s6.data.gate.matched.critical], ['block', 'new', 1]);

  // Accept: text/plain: the plain summary only, same status code (422 when blocking)
  await a('PATCH', `/api/repos/${rid}`, { gate: { mode: 'block', scope: 'open' } });
  const post = (q, accept) => fetch(`${base}/api/v1/reports${q}`, {
    method: 'POST', headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json', ...(accept ? { Accept: accept } : {}) }, body: JSON.stringify(trivy),
  });
  const txt = await post('', 'text/plain');
  assert.equal(txt.status, 422);
  assert.match(txt.headers.get('content-type'), /text\/plain/);
  const body = await txt.text();
  assert.match(body, /^ScanHub · gate-repo · สแกน #\d+\n/);
  assert.match(body, /ยังเปิดอยู่ \d+ รายการ \(Critical \d+ · High \d+/);
  assert.match(body, /ผลการตรวจ: ไม่ผ่าน/);
  assert.match(body, /ดูผล: http:\/\/scanhub\.test\/#repo\//);
  // report mode: 200 and still plain text; format=text works too
  const rep = await post('?gate=report&format=text');
  assert.equal(rep.status, 200);
  assert.match(await rep.text(), /ผลการตรวจ: ผ่าน \(report only/);
  // JSON when asked for JSON
  const js = await post('', 'application/json');
  assert.equal(typeof (await js.json()).summaryText, 'string');
});

test('branches, tags and pull requests: what CI scans and what each scan is compared with', async () => {
  const a = state.admin;
  const made = await a('POST', '/api/repos', { projectId: state.projectId, name: 'ref-repo', gate: { mode: 'report' } });
  const { token: tok } = made.data;
  const rid = made.data.repo.id;
  assert.deepEqual(made.data.repo.scanRefs, { branches: [], tags: [], prs: true });
  const T = fx('trivy.json');
  const T2 = fx('trivy.json');
  T2.Results[0].Vulnerabilities.push({ VulnerabilityID: 'CVE-2099-0002', PkgName: 'example.com/extra', InstalledVersion: '1.0.0', Severity: 'CRITICAL', Title: 'extra' });
  const send = (q, data) => ci(tok, `/api/v1/reports?${q}`, { reports: [{ tool: 'trivy', data }] });
  const check = async (q) => (await fetch(`${base}/api/v1/check?${q}`, { headers: { Authorization: `Bearer ${tok}`, Accept: 'text/plain' } })).text();

  // defaults: the main branch and every pull request, no tags
  assert.equal(await check('kind=branch&branch=main'), 'scan\n');
  assert.equal(await check('kind=pr&branch=feature/a&base=main'), 'scan\n');
  assert.match(await check('kind=branch&branch=feature/a'), /^skip\n.*ไม่สแกน branch feature\/a/);
  assert.match(await check('kind=tag&branch=v1.0'), /^skip\n.*ไม่ได้ตั้งให้สแกน tag/);

  assert.equal((await a('PATCH', `/api/repos/${rid}`, { scanRefs: { tags: 'bad tag!' } })).status, 400);
  const set = await a('PATCH', `/api/repos/${rid}`, { scanRefs: { branches: 'main, release/*', tags: ['sit_v*', 'uat_v*'] } });
  assert.deepEqual(set.data.scanRefs, { branches: ['main', 'release/*'], tags: ['sit_v*', 'uat_v*'], prs: true });
  assert.equal(await check('kind=branch&branch=release/1.0'), 'scan\n');
  assert.equal(await check('kind=tag&branch=uat_v2.3'), 'scan\n');
  assert.match(await check('kind=tag&branch=prod_v1'), /^skip/);

  // each branch is compared with its own previous scan
  const m1 = await send('kind=branch&branch=main', T);
  const N = m1.data.newCount;
  assert.ok(N > 0);
  const r1 = await send('kind=branch&branch=release/1.0', T2);
  assert.equal(r1.data.newCount, N + 1, 'first scan of release/1.0');
  const m2 = await send('kind=branch&branch=main', T);
  assert.deepEqual([m2.data.newCount, m2.data.fixedCount], [0, 0], 'main compares with main, not release/1.0');

  // a pull request compares with its target branch: only what it adds is new
  const pr = await send('kind=pr&branch=feature/a&base=main', T2);
  assert.equal(pr.data.newCount, 1);
  const prDetail = await a('GET', `/api/scans/${pr.data.scanId}`);
  assert.deepEqual([prDetail.data.refType, prDetail.data.baseBranch, prDetail.data.prev.num, prDetail.data.prev.branch], ['pr', 'main', m2.data.num, 'main']);

  // tags compare within their own pattern: sit_v1.1 with sit_v1.0, not with uat_v1.0
  assert.equal((await send('kind=tag&branch=sit_v1.0', T)).data.newCount, N);
  const uat = await send('kind=tag&branch=uat_v1.0', T2);
  assert.equal(uat.data.newCount, N + 1);
  assert.equal((await send('kind=tag&branch=sit_v1.1', T2)).data.newCount, 1);
  const prod = await send('kind=tag&branch=prod_v1', T);
  assert.equal(prod.data.skipped, true);

  // pipelines made before branch rules (no kind) are always scanned, as a branch
  const legacy = await send('branch=feature/old', T);
  assert.equal(legacy.status, 200);
  assert.equal((await a('GET', `/api/scans/${legacy.data.scanId}`)).data.refType, 'branch');

  // history lines: main first, one line per tag pattern
  const refs = (await a('GET', `/api/repos/${rid}/refs`)).data;
  assert.deepEqual([refs[0].kind, refs[0].ref, refs[0].main, refs[0].count], ['branch', 'main', true, 2]);
  const sit = refs.find((x) => x.kind === 'tag' && x.ref === 'sit_v*');
  assert.deepEqual([sit.count, sit.last.branch], [2, 'sit_v1.1']);
  assert.ok(refs.some((x) => x.kind === 'pr' && x.ref === 'feature/a'));
  assert.equal((await a('GET', `/api/repos/${rid}/scans?kind=tag&ref=${encodeURIComponent('sit_v*')}`)).data.length, 2);
  const ofUat = (await a('GET', `/api/repos/${rid}/scans?of=${uat.data.num}`)).data;
  assert.deepEqual(ofUat.map((s) => s.branch), ['uat_v1.0']);
  assert.equal((await a('GET', `/api/repos/${rid}/scans`)).data.length, 8, 'no filter: every scan');

  // the project list shows the main branch's latest scan, not the newest tag
  const listed = (await a('GET', '/api/projects')).data.flatMap((p) => p.repos).find((x) => x.id === rid);
  assert.equal(listed.lastScan.num, m2.data.num);
});

test('CI source upload: size check and failed scan reporting', async () => {
  const empty = await fetch(`${base}/api/v1/scan`, { method: 'POST', headers: { Authorization: `Bearer ${state.token}` }, body: Buffer.alloc(0) });
  assert.equal(empty.status, 400);
  // not a tar archive: the scan is created, then fails; wait=1 reports 500
  const r = await ci(state.token, '/api/v1/scan?branch=main&commit=abc&wait=1&fail_on=critical', zlib.gzipSync(Buffer.from('not a tar')));
  assert.equal(r.status, 500);
  assert.equal(r.data.status, 'failed');
  assert.ok(r.data.error);
  // the projects list shows the failed scan as the repo's last scan (not the older done one)
  const projects = (await state.admin('GET', '/api/projects')).data;
  const repo = projects.flatMap((p) => p.repos).find((x) => x.id === state.repoId);
  assert.equal(repo.lastScan.status, 'failed');
  assert.equal(repo.lastScan.num, r.data.num);
  // without wait it is accepted right away
  const r2 = await ci(state.token, '/api/v1/scan?branch=main', zlib.gzipSync(Buffer.from('x')));
  assert.equal(r2.status, 202);
  assert.ok(r2.data.scanId);
});

test('token regeneration revokes the old token', async () => {
  const r = await state.admin('POST', `/api/repos/${state.repoId}/token`);
  assert.match(r.data.token, /^shr_/);
  assert.equal((await ci(state.token, '/api/v1/reports', { reports: [{ tool: 'trivy', data: {} }] })).status, 401);
  state.token = r.data.token;
});

test('users: temp password gate, roles, disable and reset', async () => {
  const a = state.admin;
  assert.equal((await a('POST', '/api/users', { username: 'anupat.p', password: 'short', role: 'ANALYST' })).status, 400);
  const u = await a('POST', '/api/users', { username: 'anupat.p', password: 'temp-pass-1', role: 'ANALYST' });
  assert.equal(u.status, 201);
  assert.equal(u.data.mustChange, true);
  assert.equal((await a('POST', '/api/users', { username: 'anupat.p', password: 'temp-pass-1', role: 'ANALYST' })).status, 409);
  // old role names still work; no role means the least access
  assert.equal((await a('POST', '/api/users', { username: 'legacy.qa', password: 'temp-pass-1', role: 'QA' })).data.role, 'ANALYST');
  assert.equal((await a('POST', '/api/users', { username: 'no.role', password: 'temp-pass-1' })).data.role, 'VIEWER');
  assert.equal((await a('POST', '/api/users', { username: 'bad.role', password: 'temp-pass-1', role: 'OWNER' })).status, 400);

  const qa = client();
  const login = await qa('POST', '/api/auth/login', { username: 'anupat.p', password: 'temp-pass-1' });
  assert.equal(login.data.user.mustChange, true);
  const blocked = await qa('GET', '/api/projects');
  assert.equal(blocked.status, 403);
  assert.equal(blocked.data.code, 'MUST_CHANGE_PASSWORD');
  assert.equal((await qa('POST', '/api/auth/change-password', { current: 'wrong', newPassword: 'new-pass-123' })).status, 400);
  assert.equal((await qa('POST', '/api/auth/change-password', { current: 'temp-pass-1', newPassword: 'new-pass-123' })).data.user.mustChange, false);
  await a('PATCH', `/api/users/${u.data.id}`, { allProjects: true });

  // ANALYST: view and trigger, not manage
  assert.equal((await qa('GET', '/api/projects')).status, 200);
  assert.equal((await qa('POST', '/api/projects', { name: 'Nope' })).status, 403);
  assert.equal((await qa('GET', '/api/users')).status, 403);
  assert.equal((await qa('GET', '/api/settings')).status, 403);
  assert.equal((await qa('POST', `/api/repos/${state.repoId}/scan`, {})).status, 400, 'allowed, but repo has no git url');

  // VIEWER cannot trigger scans; MAINTAINER can manage repos but not settings
  await a('PATCH', `/api/users/${u.data.id}`, { role: 'VIEWER' });
  assert.equal((await qa('POST', `/api/repos/${state.repoId}/scan`, {})).status, 403);
  await a('PATCH', `/api/users/${u.data.id}`, { role: 'MAINTAINER' });
  assert.equal((await qa('GET', '/api/settings')).status, 200);
  assert.equal((await qa('PUT', '/api/settings', { retentionDays: 1 })).status, 403);
  assert.equal((await qa('POST', '/api/projects', { name: 'Mobile Banking' })).status, 201);

  // disable logs them out and blocks login
  await a('PATCH', `/api/users/${u.data.id}`, { active: false });
  assert.equal((await qa('GET', '/api/projects')).status, 401);
  assert.equal((await qa('POST', '/api/auth/login', { username: 'anupat.p', password: 'new-pass-123' })).status, 401);
  await a('PATCH', `/api/users/${u.data.id}`, { active: true });

  // reset puts the temp-password gate back
  await a('POST', `/api/users/${u.data.id}/reset-password`, { password: 'another-temp-1' });
  const again = await qa('POST', '/api/auth/login', { username: 'anupat.p', password: 'another-temp-1' });
  assert.equal(again.data.user.mustChange, true);

  // env admin is locked
  const users = (await a('GET', '/api/users')).data;
  const envAdmin = users.find((x) => x.fromEnv);
  assert.equal(envAdmin.username, 'admin');
  assert.equal((await a('PATCH', `/api/users/${envAdmin.id}`, { role: 'ANALYST' })).status, 400);
  assert.equal((await a('POST', '/api/auth/change-password', { current: ADMIN_PW, newPassword: 'whatever-1' })).status, 400);
});

test('project access: grants, groups, all projects, creator grant, 404 for hidden', async () => {
  const a = state.admin;
  // second project with one scan
  const mob = await a('POST', '/api/projects', { name: 'Mobile Access Test' });
  const repo = await a('POST', '/api/repos', { projectId: mob.data.id, name: 'mb-bff', lang: 'Node.js' });
  const scan = await ci(repo.data.token, '/api/v1/reports?gate=report', { reports: [{ tool: 'gitleaks', data: fx('gitleaks.json') }] });
  assert.equal(scan.status, 200);

  const u = await a('POST', '/api/users', { username: 'qa.limited', password: 'temp-pass-5', role: 'ANALYST' });
  assert.deepEqual([u.data.allProjects, u.data.projectIds, u.data.groupIds], [false, [], []]);
  const qa = client();
  await qa('POST', '/api/auth/login', { username: 'qa.limited', password: 'temp-pass-5' });
  await qa('POST', '/api/auth/change-password', { current: 'temp-pass-5', newPassword: 'qa-limited-1' });
  const names = async () => (await qa('GET', '/api/projects')).data.map((p) => p.name).sort();

  // new users see nothing; hidden things are 404
  assert.deepEqual(await names(), []);
  assert.equal((await qa('GET', `/api/repos/${repo.data.repo.id}`)).status, 404);
  assert.equal((await qa('GET', `/api/repos/${repo.data.repo.id}/scans`)).status, 404);
  assert.equal((await qa('GET', `/api/scans/${scan.data.scanId}`)).status, 404);
  assert.equal((await qa('GET', `/api/scans/${scan.data.scanId}/report`)).status, 404);
  assert.equal((await qa('GET', `/api/scans/${scan.data.scanId}/shares`)).status, 404);
  assert.equal((await qa('POST', `/api/scans/${scan.data.scanId}/shares`, { mode: 'internal' })).status, 404);

  // direct grant
  const patched = await a('PATCH', `/api/users/${u.data.id}`, { projectIds: [state.projectId] });
  assert.deepEqual(patched.data.projectIds, [state.projectId]);
  assert.deepEqual(await names(), ['Payment Platform']);
  assert.equal((await qa('GET', `/api/repos/${repo.data.repo.id}`)).status, 404);
  assert.equal((await a('PATCH', `/api/users/${u.data.id}`, { projectIds: [999999] })).status, 400);

  // group with the mobile project
  assert.equal((await a('POST', '/api/groups', { name: 'x' })).status, 400);
  const g = await a('POST', '/api/groups', { name: 'Mobile team', memberIds: [u.data.id], projectIds: [mob.data.id] });
  assert.equal(g.status, 201);
  assert.deepEqual([g.data.memberIds, g.data.projectIds, g.data.allProjects], [[u.data.id], [mob.data.id], false]);
  assert.equal((await a('POST', '/api/groups', { name: 'Mobile team' })).status, 409);
  assert.deepEqual(await names(), ['Mobile Access Test', 'Payment Platform']);
  assert.equal((await qa('GET', `/api/scans/${scan.data.scanId}`)).status, 200);
  assert.deepEqual((await a('GET', '/api/users')).data.find((x) => x.id === u.data.id).groupIds, [g.data.id]);
  assert.equal((await qa('GET', '/api/groups')).status, 403);

  const access = (await a('GET', `/api/projects/${mob.data.id}/access`)).data;
  assert.deepEqual(access.groups, [{ id: g.data.id, name: 'Mobile team' }]);
  assert.deepEqual(access.users.find((x) => x.username === 'qa.limited').via, ['group:Mobile team']);
  assert.deepEqual(access.users.find((x) => x.username === 'admin').via.includes('all'), true);
  assert.ok(!access.users.some((x) => x.username === 'dev.viewer'));
  assert.equal((await qa('GET', `/api/projects/${mob.data.id}/access`)).status, 403);

  // arrays replace; removing the project from the group hides it again
  await a('PATCH', `/api/groups/${g.data.id}`, { projectIds: [] });
  assert.deepEqual(await names(), ['Payment Platform']);
  // a group with all projects
  await a('PATCH', `/api/groups/${g.data.id}`, { allProjects: true });
  const allNames = (await a('GET', '/api/projects')).data.map((p) => p.name).sort();
  assert.deepEqual(await names(), allNames);
  assert.equal((await a('DELETE', `/api/groups/${g.data.id}`)).status, 200);
  assert.deepEqual(await names(), ['Payment Platform']);

  // user-level all projects
  await a('PATCH', `/api/users/${u.data.id}`, { allProjects: true });
  assert.ok((await names()).includes('Mobile Access Test'));
  await a('PATCH', `/api/users/${u.data.id}`, { allProjects: false, projectIds: [] });
  assert.deepEqual(await names(), []);

  // the creator of a project gets a direct grant
  const sa = await a('POST', '/api/users', { username: 'sa.creator', password: 'temp-pass-6', role: 'MAINTAINER' });
  const sac = client();
  await sac('POST', '/api/auth/login', { username: 'sa.creator', password: 'temp-pass-6' });
  await sac('POST', '/api/auth/change-password', { current: 'temp-pass-6', newPassword: 'sa-creator-1' });
  const own = await sac('POST', '/api/projects', { name: 'SA Own Project' });
  assert.deepEqual((await sac('GET', '/api/projects')).data.map((p) => p.name), ['SA Own Project']);
  assert.equal((await sac('POST', '/api/repos', { projectId: state.projectId, name: 'sneaky-repo' })).status, 404, 'cannot add repos to a hidden project');
  assert.equal((await sac('POST', '/api/repos', { projectId: own.data.id, name: 'sa-repo' })).status, 201);
  assert.deepEqual((await a('GET', `/api/projects/${own.data.id}/access`)).data.users.find((x) => x.id === sa.data.id).via, ['direct']);

  // the env admin always sees everything and cannot be changed
  const envAdmin = (await a('GET', '/api/users')).data.find((x) => x.fromEnv);
  assert.equal(envAdmin.allProjects, true);
  assert.equal((await a('PATCH', `/api/users/${envAdmin.id}`, { projectIds: [] })).status, 400);
});

test('git connections: CRUD, encrypted token, test, repo search, one-click setup', async () => {
  const { startFakeGit } = await import('./helpers/fake-git.js');
  const { openSealedBox } = await import('../server/git/sealedbox.js');
  const fake = await startFakeGit();
  try {
    const a = state.admin;
    assert.equal((await a('POST', '/api/integrations', { type: 'bitbucket', name: 'x', token: 't' })).status, 400);
    const created = await a('POST', '/api/integrations', { type: 'github', name: 'Acme GitHub', baseUrl: fake.github, token: 'ghp_super_secret_token' });
    assert.equal(created.status, 201);
    assert.deepEqual([created.data.tokenSet, created.data.fromEnv, created.data.baseUrl], [true, false, fake.github]);
    assert.ok(!('token' in created.data));
    const stored = (await pgdb.query('SELECT token_enc FROM integrations WHERE id = $1', [created.data.id]))[0].token_enc;
    assert.ok(stored.startsWith('v1:') && !stored.includes('ghp_super_secret_token'), 'token encrypted at rest');

    const t = await a('POST', `/api/integrations/${created.data.id}/test`);
    assert.deepEqual([t.data.ok, t.data.account, t.data.scopesOk], [true, 'octo', true]);
    assert.equal((await a('GET', '/api/integrations')).data.find((i) => i.id === created.data.id).account, 'octo');
    const repos = await a('GET', `/api/integrations/${created.data.id}/repos?q=payment`);
    assert.deepEqual(repos.data.map((r) => r.fullName), ['acme/payment-api']);

    // one-click setup on a ScanHub repo
    const r = await a('POST', '/api/repos', { projectId: state.projectId, name: 'auto-setup-repo', lang: 'Go' });
    assert.equal((await a('POST', `/api/repos/${r.data.repo.id}/auto-setup`, { integrationId: created.data.id, remoteRepo: 'acme/payment-api', gate: { mode: 'nope' } })).status, 400);
    const res = await a('POST', `/api/repos/${r.data.repo.id}/auto-setup`, { integrationId: created.data.id, remoteRepo: 'acme/payment-api', gate: { mode: 'report' }, mode: 'pr' });
    assert.equal(res.status, 200);
    assert.equal(res.data.ok, true);
    assert.deepEqual(res.data.steps.map((s) => s.key), ['token', 'secret', 'file', 'pr', 'link']);
    assert.equal(res.data.prUrl, 'https://github.test/acme/payment-api/pull/7');
    // the old repo token no longer works, the new one (in the GitHub secret) does
    assert.equal((await ci(r.data.token, '/api/v1/reports', { reports: [{ tool: 'trivy', data: {} }] })).status, 401);
    const newToken = openSealedBox(fake.state.gh.secrets.SCANHUB_TOKEN.encrypted_value, fake.state.keys.publicKey, fake.state.keys.secretKey);
    // the gate chosen at setup is saved on the repo: report only, so new criticals do not fail the pipeline
    const viaCi = await ci(newToken, '/api/v1/reports', { reports: [{ tool: 'trivy', data: fx('trivy.json') }] });
    assert.equal(viaCi.status, 200);
    assert.equal(viaCi.data.gate.mode, 'report');
    assert.ok(viaCi.data.gate.matched.critical > 0);
    assert.equal(fake.state.gh.variables.SCANHUB_URL, 'http://scanhub.test');
    const linked = (await a('GET', `/api/repos/${r.data.repo.id}`)).data;
    assert.deepEqual(linked.remote, { integrationId: created.data.id, fullName: 'acme/payment-api', webUrl: 'https://github.test/acme/payment-api' });
    assert.equal(linked.gitUrl, 'https://github.test/acme/payment-api.git');
    assert.equal(linked.branch, 'main');
    assert.deepEqual(linked.gate, { mode: 'report', severities: ['critical', 'high'], scope: 'new' });

    // a failing step is reported and stops the rest
    const bad = await a('POST', `/api/repos/${r.data.repo.id}/auto-setup`, { integrationId: created.data.id, remoteRepo: 'acme/missing', mode: 'pr' });
    assert.equal(bad.data.ok, false);
    assert.deepEqual(bad.data.steps.map((s) => [s.key, s.ok]), [['token', true], ['secret', false]]);
    assert.match(bad.data.steps[1].message, /404/);
    assert.equal((await a('POST', `/api/repos/${r.data.repo.id}/auto-setup`, { integrationId: created.data.id, remoteRepo: 'not a repo' })).status, 400);

    // roles: integrations are ADMIN only, repo search + setup also MAINTAINER, nothing for ANALYST
    const qa = client();
    await qa('POST', '/api/auth/login', { username: 'qa.limited', password: 'qa-limited-1' });
    assert.equal((await qa('GET', '/api/integrations')).status, 403);
    // MAINTAINER can list connections (never with tokens) but not change them
    const sa = client();
    await sa('POST', '/api/auth/login', { username: 'sa.creator', password: 'sa-creator-1' });
    const saList = await sa('GET', '/api/integrations');
    assert.equal(saList.status, 200);
    assert.ok(saList.data.length >= 1 && saList.data.every((i) => !('token' in i) && !('token_enc' in i) && !('tokenEnc' in i)));
    assert.equal((await sa('POST', '/api/integrations', { type: 'github', name: 'Nope', token: 't' })).status, 403);
    assert.equal((await sa('POST', `/api/integrations/${created.data.id}/test`)).status, 403);
    assert.equal((await qa('POST', `/api/repos/${r.data.repo.id}/auto-setup`, { integrationId: created.data.id, remoteRepo: 'acme/payment-api' })).status, 403);

    // edit keeps the token unless a new one is given; delete unlinks repos
    assert.equal((await a('PATCH', `/api/integrations/${created.data.id}`, { name: 'Acme', token: '' })).data.name, 'Acme');
    assert.equal((await a('POST', `/api/integrations/${created.data.id}/test`)).data.ok, true);
    assert.equal((await a('DELETE', `/api/integrations/${created.data.id}`)).status, 200);
    assert.equal((await a('GET', `/api/repos/${r.data.repo.id}`)).data.remote, null);
  } finally {
    await fake.close();
  }
});

test('restart re-applies the admin from env', async () => {
  proc.kill();
  await new Promise((r) => setTimeout(r, 500));
  ({ p: proc, base } = await startServer({ SCANHUB_ADMIN_PASSWORD: 'changed-in-env-2', SONAR_URL: 'https://sonar.env.example', SONAR_TOKEN: 'squ_env', NVD_API_KEY: 'nvd-env-key' }));
  const c = client();
  assert.equal((await c('POST', '/api/auth/login', { username: 'admin', password: ADMIN_PW })).status, 401);
  assert.equal((await c('POST', '/api/auth/login', { username: 'admin', password: 'changed-in-env-2' })).status, 200);
  // the old admin session was dropped because the password changed
  assert.equal((await state.admin('GET', '/api/projects')).status, 401);
  // scans that were queued when the server stopped are failed, not stuck
  const scans = (await c('GET', `/api/repos/${state.repoId}/scans`)).data;
  assert.ok(scans.every((s) => s.status === 'done' || s.status === 'failed'));

  // SonarQube and NVD from env: configured and read-only
  const st = (await c('GET', '/api/settings')).data;
  assert.deepEqual(st.sonar, { url: 'https://sonar.env.example', tokenSet: true, fromEnv: true });
  assert.equal(st.nvdFromEnv, true);
  assert.equal(st.nvdKeySet, true);
  const put = await c('PUT', '/api/settings', { sonar: { url: 'https://other.example', token: null }, nvdApiKey: null, retentionDays: 45 });
  assert.equal(put.status, 200);
  assert.deepEqual(put.data.sonar, { url: 'https://sonar.env.example', tokenSet: true, fromEnv: true });
  assert.equal(put.data.nvdKeySet, true);
  assert.equal(put.data.retentionDays, 45);
  assert.equal((await c('GET', '/api/tools')).data.find((t) => t.id === 'sonarqube').configured, true);
});
