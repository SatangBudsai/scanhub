// API helpers on Playwright's request context. Used to create test data fast; the UI is exercised by the specs.
import { request } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ADMIN, baseURL, CONTAINER, FIXTURES } from './env.js';

export const uid = (p = 'e2e') => `${p}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
export const fixture = (name) => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'));

async function ok(res, what) {
  if (!res.ok()) throw new Error(`${what}: ${res.status()} ${await res.text()}`);
  const t = await res.text();
  return t ? JSON.parse(t) : null;
}

/** A logged-in API client (own cookie jar) */
export async function apiAs(username, password) {
  const ctx = await request.newContext({ baseURL: baseURL() });
  await ok(await ctx.post('/api/auth/login', { data: { username, password } }), `login ${username}`);
  const call = async (method, p, data) => ok(await ctx.fetch(p, { method, data }), `${method} ${p}`);
  return {
    ctx,
    get: (p) => call('GET', p),
    post: (p, d) => call('POST', p, d ?? {}),
    patch: (p, d) => call('PATCH', p, d),
    put: (p, d) => call('PUT', p, d),
    del: (p) => call('DELETE', p),
    raw: (method, p, data) => ctx.fetch(p, { method, data }),
    dispose: () => ctx.dispose(),
  };
}
export const adminApi = () => apiAs(ADMIN.username, ADMIN.password);

/** Finish first-run setup through the API if a spec runs on its own */
export async function ensureSetup(api) {
  const s = await api.get('/api/setup');
  if (!s.done) {
    await api.post('/api/setup', { tools: ['trivy', 'semgrep', 'gitleaks', 'grype', 'checkov', 'dependency-check'], schedule: { enabled: true, time: '03:00', updateDb: true } });
  }
}

export async function createProject(api, name = uid('proj')) {
  return api.post('/api/projects', { name });
}
export async function createRepo(api, projectId, extra = {}) {
  const r = await api.post('/api/repos', { projectId, name: uid('repo'), lang: 'Go', branch: 'main', ...extra });
  return { repo: r.repo, token: r.token };
}
/** Project + repo in one go */
export async function projectWithRepo(api, extra = {}) {
  const project = await createProject(api, uid('Project'));
  const { repo, token } = await createRepo(api, project.id, extra);
  return { project, repo, token };
}

/** A user who already changed the temporary password, ready to log in */
export async function makeUser(api, { role = 'ANALYST', allProjects = false, projectIds = [], groupIds = [], prefix } = {}) {
  const username = uid(prefix || role.toLowerCase()).toLowerCase().slice(0, 40);
  const temp = 'temp-pass-123';
  const password = 'user-pass-456';
  const u = await api.post('/api/users', { username, password: temp, role });
  if (role !== 'ADMIN') await api.patch(`/api/users/${u.id}`, { allProjects, projectIds, groupIds });
  const me = await apiAs(username, temp);
  await me.post('/api/auth/change-password', { current: temp, newPassword: password });
  await me.dispose();
  return { id: u.id, username, password };
}

// ---------- CI API (repo token) ----------
export async function ciRequest() {
  return request.newContext({ baseURL: baseURL() });
}

/** POST /api/v1/scan exactly like the generated snippets: gzip tar body, Accept: text/plain */
export async function uploadSource(token, body, { query = 'branch=main&commit=e2e0001&wait=1', text = true, timeout = 600_000 } = {}) {
  const ctx = await ciRequest();
  try {
    const res = await ctx.post(`/api/v1/scan?${query}`, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/gzip', ...(text ? { Accept: 'text/plain' } : {}) },
      data: body,
      timeout,
    });
    const raw = await res.text();
    return { status: res.status(), text: raw, json: text ? null : JSON.parse(raw) };
  } finally { await ctx.dispose(); }
}

/** POST /api/v1/reports with scanner JSON reports */
export async function uploadReports(token, reports, { query = '', branch = 'main', commit = 'e2e0002', text = false } = {}) {
  const ctx = await ciRequest();
  try {
    const res = await ctx.post(`/api/v1/reports${query ? '?' + query : ''}`, {
      headers: { Authorization: `Bearer ${token}`, ...(text ? { Accept: 'text/plain' } : {}) },
      data: { branch, commit, reports },
      timeout: 120_000,
    });
    const raw = await res.text();
    return { status: res.status(), text: raw, json: text ? null : JSON.parse(raw) };
  } finally { await ctx.dispose(); }
}

export const standardReports = () => [
  { tool: 'trivy', data: fixture('trivy.json') },
  { tool: 'gitleaks', data: fixture('gitleaks.json') },
  { tool: 'semgrep', data: fixture('semgrep.json') },
];

// ---------- inside the container ----------
/** Run SQL against the bundled PostgreSQL (only when the suite owns the container) */
export function sql(statement) {
  const script = `PGPASSWORD="$(cat /data/postgres/.scanhub-pw)" /usr/lib/postgresql/16/bin/psql -h 127.0.0.1 -U scanhub -d scanhub -tAc "$1"`;
  return execFileSync('docker', ['exec', CONTAINER, 'bash', '-c', script, 'sql', statement], { encoding: 'utf8' }).trim();
}

export async function fakeGitState(host) {
  const ctx = await request.newContext();
  try { return await (await ctx.get(`${host}/__state`)).json(); } finally { await ctx.dispose(); }
}
export async function fakeGitReset(host) {
  const ctx = await request.newContext();
  try { await ctx.post(`${host}/__reset`); } finally { await ctx.dispose(); }
}
