// Packs a directory as gzip tar, the same bytes `tar --exclude=.git -czf - .` sends from CI
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function tgz(dir) {
  const r = spawnSync('tar', ['--exclude=.git', '-czf', '-', '-C', dir, '.'], { maxBuffer: 512 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`tar failed: ${r.stderr?.toString() || r.error}`);
  return r.stdout;
}

/** Copy a directory to a temp dir, apply edits ({ 'rel/path': 'content' | null }), return the tgz */
export function tgzWith(dir, edits) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scanhub-e2e-'));
  fs.cpSync(dir, tmp, { recursive: true });
  for (const [rel, content] of Object.entries(edits)) {
    const p = path.join(tmp, rel);
    if (content === null) fs.rmSync(p, { force: true });
    else { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content); }
  }
  try { return tgz(tmp); } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}
