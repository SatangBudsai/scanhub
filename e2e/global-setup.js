// Starts ScanHub in Docker (unless E2E_BASE_URL points to a running instance) and the fake GitHub / GitLab API,
// then pre-warms the scanner databases with one real scan so later tests stay fast.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { request } from '@playwright/test';
import { ADMIN, baseURL, COMPOSE_PROJECT, E2E_DIR, FAKE_GIT_PORT, GIF_DIR, PORT, RESULTS, SAMPLE_APP } from './lib/env.js';
import { startFakeGitServer } from './lib/fake-git-server.js';
import { tgz } from './lib/source.js';

const log = (...a) => console.log('[e2e]', ...a);
const composeArgs = () => {
  const files = ['-f', path.join(E2E_DIR, 'docker-compose.e2e.yml')];
  if (process.env.E2E_DEV === '1') files.push('-f', path.join(E2E_DIR, 'docker-compose.e2e.dev.yml'));
  return ['compose', '-p', COMPOSE_PROJECT, ...files];
};
const composeEnv = () => ({ ...process.env, E2E_PORT: String(PORT), FAKE_GIT_PORT: String(FAKE_GIT_PORT) });
const docker = (args, opts = {}) => execFileSync('docker', args, { stdio: 'inherit', env: composeEnv(), ...opts });

async function waitForHealth(url, ms) {
  const ctx = await request.newContext();
  const until = Date.now() + ms;
  try {
    while (Date.now() < until) {
      try {
        const r = await ctx.get(`${url}/api/health`, { timeout: 5000 });
        if (r.ok()) return await r.json();
      } catch {}
      await new Promise((r) => setTimeout(r, 1500));
    }
  } finally { await ctx.dispose(); }
  throw new Error(`ScanHub did not become healthy at ${url}`);
}

async function prewarm(url) {
  const ctx = await request.newContext({ baseURL: url });
  try {
    const login = await ctx.post('/api/auth/login', { data: ADMIN });
    if (!login.ok()) throw new Error(`admin login failed: ${login.status()} ${await login.text()}`);
    const project = await (await ctx.post('/api/projects', { data: { name: `E2E warmup ${Date.now()}` } })).json();
    const r = await (await ctx.post('/api/repos', { data: { projectId: project.id, name: `warmup-${Date.now().toString(36)}`, lang: 'Go', branch: 'main' } })).json();
    log('pre-warming scanner databases (first run downloads Trivy and Grype DBs, a few minutes)');
    const t0 = Date.now();
    const res = await ctx.post('/api/v1/scan?branch=main&commit=warmup&wait=1&gate=report', {
      headers: { Authorization: `Bearer ${r.token}`, 'Content-Type': 'application/gzip', Accept: 'text/plain' },
      data: tgz(SAMPLE_APP),
      timeout: 15 * 60 * 1000,
    });
    log(`warm-up scan ${res.status()} in ${Math.round((Date.now() - t0) / 1000)}s`);
    if (res.status() !== 200) throw new Error(`warm-up scan failed: ${res.status()} ${await res.text()}`);
    // the warm-up project is not part of any test
    const repo = r.repo;
    await ctx.delete(`/api/repos/${repo.id}`);
    await ctx.delete(`/api/projects/${project.id}`);
  } finally { await ctx.dispose(); }
}

export default async function globalSetup() {
  // A shell or editor sitting in the folder locks it on Windows: empty it instead of failing
  try { fs.rmSync(GIF_DIR, { recursive: true, force: true }); }
  catch { for (const f of fs.readdirSync(GIF_DIR)) fs.rmSync(path.join(GIF_DIR, f), { recursive: true, force: true }); }
  fs.mkdirSync(GIF_DIR, { recursive: true });

  const external = !!process.env.E2E_BASE_URL;
  const fake = await startFakeGitServer(FAKE_GIT_PORT);
  log(`fake GitHub/GitLab API on :${fake.port}`);
  process.env.E2E_FAKE_GIT = `http://127.0.0.1:${FAKE_GIT_PORT}`;
  process.env.E2E_FAKE_GIT_APP ||= `http://host.docker.internal:${FAKE_GIT_PORT}`;

  if (!external) {
    // the scanner DB cache survives between runs; everything else starts empty
    spawnSync('docker', ['volume', 'create', 'scanhub-e2e-cache'], { stdio: 'ignore' });
    docker(['run', '--rm', '--user', 'root', '--entrypoint', 'chown', '-v', 'scanhub-e2e-cache:/c', 'scanhub:latest', '10001:10001', '/c']);
    docker([...composeArgs(), 'down', '-v', '--remove-orphans'], { stdio: 'ignore' });
    log(`starting ScanHub on :${PORT}${process.env.E2E_DEV === '1' ? ' (working-copy server/ and public/ mounted)' : ''}`);
    docker([...composeArgs(), 'up', '-d']);
    process.env.E2E_OWNS_CONTAINER = '1';
  }
  const url = baseURL();
  process.env.E2E_BASE_URL = url;
  const health = await waitForHealth(url, 240_000);
  log(`ScanHub ${health.version} is up at ${url}`);
  if (process.env.E2E_SKIP_WARMUP !== '1') await prewarm(url);

  fs.mkdirSync(RESULTS, { recursive: true });
  fs.writeFileSync(path.join(RESULTS, '.meta.json'), JSON.stringify({ version: health.version, baseUrl: url, startedAt: new Date().toISOString(), dev: process.env.E2E_DEV === '1', external }));

  return async () => {
    await fake.close();
    if (!external && process.env.E2E_KEEP !== '1') {
      log('removing the E2E container and volume');
      docker([...composeArgs(), 'down', '-v', '--remove-orphans'], { stdio: 'ignore' });
    }
  };
}
