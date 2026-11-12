import fs from 'node:fs';
import path from 'node:path';
import { dirs } from '../config.js';
import { ensureDir, json, nowIso, rmrf, runCmd, tail } from '../util.js';
import { CATALOG, toolById } from '../tools/catalog.js';
import { PARSERS } from './parsers/index.js';
import { mergeFindings } from './merge.js';
import { failScan, saveResults } from './store.js';
import { runSonar } from './sonar.js';
import { effectiveNvdKey, effectiveSemgrep, effectiveSonar } from '../settings.js';
import { decrypt } from '../secrets.js';
import { cloneAuthHeader } from '../git/providers.js';

const PARSER_FOR = { sonarqube: 'sonarqube-issues' };

/** Which tools a scan runs: explicit request, else repo setting, else every installed tool. */
export async function selectTools(repo, requested, tools) {
  const repoTools = json(repo.tools, null);
  let ids = requested && requested.length ? requested : repoTools && repoTools.length ? repoTools : null;
  if (!ids) {
    ids = [];
    for (const t of CATALOG) if ((await tools.isEnabled(t.id)) && (await tools.installedBin(t.id))) ids.push(t.id);
  }
  return CATALOG.map((t) => t.id).filter((id) => ids.includes(id));
}

export function createRunner(db, tools, lock) {
  async function runTool(id, { src, out, repo }) {
    const item = toolById(id);
    const release = await lock.shared(id);
    try {
      if (!(await tools.isEnabled(id))) return { skip: 'Disabled in settings' };
      const bin = await tools.installedBin(id);
      if (!bin) return { skip: 'Scanner not installed' };
      if (id === 'sonarqube') {
        const { url, token, note } = await effectiveSonar(db);
        if (!url || !token) return { skip: note || 'SonarQube URL and token are not set' };
        return { ...(await runSonar({ bin, src, out, repo, url, token })), ctx: { sonarUrl: url } };
      }
      if (id === 'semgrep') {
        // Registry rules need the installer to accept their license; skip (not fail) until a source is chosen
        const sg = await effectiveSemgrep(db);
        if (!sg.rules) return { skip: sg.note };
        return await item.run.call(item, { bin, src, out, ctx: { semgrepRules: sg.rules } });
      }
      const nvdApiKey = await effectiveNvdKey(db);
      return await item.run.call(item, { bin, src, out, ctx: { nvdApiKey } });
    } finally {
      release();
    }
  }

  /** Run every selected tool on a source dir, merge and save. prepare() returns the source dir. */
  async function execute(scanId, prepare) {
    const work = path.join(dirs.work, String(scanId));
    const runs = [];
    try {
      await db.run(`UPDATE scans SET status = 'running', started_at = ? WHERE id = ?`, nowIso(), scanId);
      rmrf(work);
      ensureDir(work);
      const scan = await db.get('SELECT * FROM scans WHERE id = ?', scanId);
      const repo = await db.get('SELECT * FROM repos WHERE id = ?', scan.repo_id);
      if (!repo) throw new Error('Repo was deleted');
      const src = await prepare(work, scan, repo);
      const ids = await selectTools(repo, json(scan.tools_req, null), tools);
      if (!ids.length) throw new Error('No scanners installed. Install them in settings');
      const raw = [];
      for (const id of ids) {
        const out = ensureDir(path.join(work, 'out', id));
        const t0 = Date.now();
        let res;
        try {
          res = await runTool(id, { src, out, repo });
        } catch (e) {
          res = { error: String(e.message || e) };
        }
        const durationMs = Date.now() - t0;
        if (res.skip) { runs.push({ tool: id, status: 'skipped', durationMs: 0, count: 0, note: res.skip }); continue; }
        if (res.error) { runs.push({ tool: id, status: 'failed', durationMs, count: 0, note: res.error }); continue; }
        try {
          const found = PARSERS[PARSER_FOR[id] || id](res.data, { src, ...(res.ctx || {}) });
          raw.push(...found);
          runs.push({ tool: id, status: 'ok', durationMs, count: found.length, note: '' });
        } catch (e) {
          runs.push({ tool: id, status: 'failed', durationMs, count: 0, note: `Could not read results: ${e.message}` });
        }
      }
      if (!runs.some((r) => r.status === 'ok')) throw new Error('No scanner finished successfully');
      await saveResults(db, scanId, mergeFindings(raw, { src }), runs);
    } catch (e) {
      await failScan(db, scanId, e.message || e, runs).catch((err) => console.error('failScan', err));
    } finally {
      rmrf(work);
    }
  }

  // Source preparation
  const fromUpload = (archive) => async (work) => {
    const src = ensureDir(path.join(work, 'src'));
    try {
      const r = await runCmd('tar', ['-xzf', archive, '-C', src], { timeoutMs: 10 * 60 * 1000 });
      if (r.code !== 0) throw new Error(`Could not extract the upload (must be tar.gz): ${tail(r.stderr)}`);
    } finally {
      rmrf(archive);
    }
    return src;
  };

  const fromGit = () => async (work, scan, repo) => {
    const src = path.join(work, 'src');
    const branch = scan.branch || repo.branch || 'main';
    const env = { GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo' };
    // Repos linked to a GitHub / GitLab connection clone with its token (sent as a header, not in the URL)
    const auth = [];
    if (repo.remote_integration_id && /^https?:/.test(repo.git_url)) {
      const integ = await db.get('SELECT type, token_enc FROM integrations WHERE id = ?', repo.remote_integration_id);
      if (integ) auth.push('-c', `http.extraHeader=${cloneAuthHeader(integ.type, await decrypt(db, integ.token_enc))}`);
    }
    const r = await runCmd('git', [...auth, 'clone', '--depth', '1', '--branch', branch, '--single-branch', repo.git_url, src], { timeoutMs: 15 * 60 * 1000, env });
    if (r.code !== 0) throw new Error(`git clone failed: ${tail(r.stderr).replace(/\/\/[^@/\s]+@/g, '//***@')}`);
    const sha = await runCmd('git', ['rev-parse', 'HEAD'], { cwd: src });
    if (sha.code === 0) await db.run('UPDATE scans SET commit_sha = ? WHERE id = ?', sha.stdout.trim(), scan.id);
    rmrf(path.join(src, '.git'));
    return src;
  };

  /** Parse reports uploaded by CI (no source on disk) and save. */
  async function ingestReports(scanId, reports) {
    await db.run(`UPDATE scans SET status = 'running', started_at = ? WHERE id = ?`, nowIso(), scanId);
    const runs = [];
    const raw = [];
    for (const rep of reports) {
      const tool = rep.tool === 'sonarqube-issues' ? 'sonarqube' : rep.tool;
      try {
        const data = typeof rep.data === 'string' ? JSON.parse(rep.data) : rep.data;
        const found = PARSERS[rep.tool](data, {});
        raw.push(...found);
        runs.push({ tool, status: 'ok', durationMs: 0, count: found.length, note: 'From a report sent by CI' });
      } catch (e) {
        runs.push({ tool, status: 'failed', durationMs: 0, count: 0, note: `Could not read report: ${e.message}` });
      }
    }
    if (!runs.some((r) => r.status === 'ok')) return failScan(db, scanId, 'Could not read any report', runs);
    try {
      await saveResults(db, scanId, mergeFindings(raw), runs);
    } catch (e) {
      await failScan(db, scanId, e.message || e, runs);
    }
  }

  return { execute, fromUpload, fromGit, ingestReports };
}

export function cleanWorkDirs() {
  rmrf(dirs.work);
  ensureDir(dirs.work);
  try {
    for (const f of fs.readdirSync(dirs.uploads)) rmrf(path.join(dirs.uploads, f));
  } catch { /* none */ }
}
