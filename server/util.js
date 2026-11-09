import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

export const bad = (msg) => new HttpError(400, msg);
export const notFound = (msg = 'Not found') => new HttpError(404, msg);

// Wrap an async route so thrown errors reach the error handler
export const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export const nowIso = () => new Date().toISOString();

export const SEV = ['critical', 'high', 'medium', 'low', 'info'];
export const sevRank = (s) => {
  const i = SEV.indexOf(s);
  return i < 0 ? SEV.length : i;
};

// jsonb columns come back parsed already; strings are parsed for safety
export function json(v, fallback = null) {
  if (v == null) return fallback;
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return fallback; }
}

/**
 * Run a command without a shell. Resolves with { code, stdout, stderr, timedOut }; never rejects
 * for a non-zero exit (spawn errors such as ENOENT resolve with code -1).
 */
export function runCmd(cmd, args = [], { cwd, env, timeoutMs = 30 * 60 * 1000, maxBuffer = 256 * 1024 * 1024 } = {}) {
  return new Promise((resolve) => {
    let stdout = '', stderr = '', timedOut = false, done = false;
    let child;
    try {
      child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, windowsHide: true });
    } catch (e) {
      resolve({ code: -1, stdout: '', stderr: String(e.message || e), timedOut: false });
      return;
    }
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.stdout.on('data', (d) => { if (stdout.length < maxBuffer) stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; if (stderr.length > 1024 * 1024) stderr = stderr.slice(-512 * 1024); });
    const finish = (code, err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr: err ? String(err.message || err) : stderr, timedOut });
    };
    child.on('error', (e) => finish(-1, e));
    child.on('close', (code) => finish(code ?? -1));
  });
}

// Last few non-empty lines of a command's output, for error notes
export function tail(text, n = 4) {
  return String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(-n).join(' · ').slice(0, 500);
}

export function rmrf(p) {
  try { fs.rmSync(p, { recursive: true, force: true, maxRetries: 3 }); } catch { /* ignore */ }
}

export function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
  return p;
}

export function findFile(dir, predicate, depth = 6) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isFile() && predicate(p, e.name)) return p;
  }
  if (depth <= 0) return null;
  for (const e of entries) {
    if (e.isDirectory()) {
      const r = findFile(path.join(dir, e.name), predicate, depth - 1);
      if (r) return r;
    }
  }
  return null;
}

export function readJsonFile(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}
