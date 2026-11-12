import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { config, dirs } from '../config.js';
import { ensureDir, rmrf, runCmd, tail } from '../util.js';
import { effectiveNvdKey, effectiveSemgrep, effectiveSonar } from '../settings.js';
import { CATALOG, linuxArch, toolBinIn, toolById, versionFrom } from './catalog.js';

/**
 * Scanners come built into the image (config.imageToolsDir). Setup and settings only enable or disable them.
 * "Update" installs a newer version into DATA_DIR/tools/<id> (the override), which then takes precedence.
 * Override installs are atomic: build in <id>.new, verify the version, swap (old kept as <id>.old until the
 * new one runs at its final path). The swap waits for scans that are using the tool.
 *
 * tools table: enabled, image_version, and installed / bin / version describing the override.
 */
export async function createToolManager(db, lock) {
  let chain = Promise.resolve();
  const enqueue = (fn) => {
    const p = chain.then(fn, fn);
    chain = p.catch(() => {});
    return p;
  };

  const row = (id) => db.get('SELECT * FROM tools WHERE id = ?', id);
  for (const t of CATALOG) await db.run('INSERT INTO tools (id) VALUES (?) ON CONFLICT (id) DO NOTHING', t.id);
  // Jobs do not survive a restart
  await db.run(`UPDATE tools SET status = 'idle', error = 'Task cancelled because the server restarted' WHERE status IN ('installing', 'updating', 'removing')`);

  // Versions of the built-in scanners, written by the image build
  let manifest = {};
  try { manifest = JSON.parse(fs.readFileSync(path.join(config.imageToolsDir, 'versions.json'), 'utf8')); } catch { /* not in the image (local dev) */ }

  const imageBin = (item) => {
    const dir = path.join(config.imageToolsDir, item.id);
    return fs.existsSync(dir) ? toolBinIn(dir, item) : null;
  };
  const overrideBin = (r) => (r && r.installed && r.bin && fs.existsSync(r.bin) ? r.bin : null);

  async function log(tool, action, ok, message) {
    await db.run('INSERT INTO tool_log (tool, action, ok, message) VALUES (?, ?, ?, ?)', tool, action, ok ? 1 : 0, String(message || '').slice(0, 1000));
    await db.run('DELETE FROM tool_log WHERE id NOT IN (SELECT id FROM tool_log ORDER BY id DESC LIMIT 500)');
  }
  const setStatus = (id, status, error = null) => db.run('UPDATE tools SET status = ?, error = ? WHERE id = ?', status, error, id);

  async function sonarConfigured() {
    const s = await effectiveSonar(db);
    return !!(s.url && s.token);
  }

  async function list() {
    const rows = new Map((await db.all('SELECT * FROM tools')).map((r) => [r.id, r]));
    const sonarOk = await sonarConfigured();
    const semgrepOk = !!(await effectiveSemgrep(db)).rules;
    return CATALOG.map((t) => {
      const r = rows.get(t.id) || {};
      const ov = overrideBin(r);
      const img = imageBin(t);
      return {
        id: t.id, name: t.name, desc: t.desc,
        installed: !!(ov || img), enabled: !!r.enabled,
        source: ov ? 'updated' : 'image',
        version: ov ? r.version : (r.image_version || null),
        imageVersion: img ? (r.image_version || null) : null,
        updatedAt: r.updated_at || null,
        status: r.status || 'idle', error: r.error || null,
        needsConfig: !!t.needsConfig || t.id === 'semgrep',
        configured: t.id === 'sonarqube' ? sonarOk : t.id === 'semgrep' ? semgrepOk : true,
      };
    });
  }

  /** The binary a scan should use: the override if there is one, else the built-in one */
  async function installedBin(id) {
    const item = toolById(id);
    return overrideBin(await row(id)) || (item ? imageBin(item) : null);
  }
  const isEnabled = async (id) => !!(await row(id))?.enabled;

  // Network calls retry: GitHub sometimes answers 5xx for a moment
  async function retry(fn, tries = 4) {
    let last;
    for (let i = 0; i < tries; i++) {
      try { return await fn(); } catch (e) {
        last = e;
        if (e.permanent) break;
        await new Promise((r) => setTimeout(r, 2000 * 2 ** i));
      }
    }
    throw last;
  }

  /** Latest release tag: the github.com redirect first (no API rate limit), then the GitHub API. */
  async function latestTag(repo) {
    try {
      return await retry(async () => {
        const res = await fetch(`https://github.com/${repo}/releases/latest`, { redirect: 'manual', headers: { 'User-Agent': 'scanhub' } });
        const m = /\/releases\/tag\/([^/?#]+)$/.exec(res.headers.get('location') || '');
        if (!m) throw new Error(`GitHub ${res.status}`);
        return decodeURIComponent(m[1]);
      }, 3);
    } catch {
      return retry(async () => {
        const headers = { 'User-Agent': 'scanhub', Accept: 'application/vnd.github+json' };
        if (config.githubToken) headers.Authorization = `Bearer ${config.githubToken}`;
        const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, { headers });
        if (!res.ok) {
          const e = new Error(`GitHub API ${res.status}${res.status === 403 ? ' (rate limit: set GITHUB_TOKEN)' : ''}`);
          e.permanent = res.status === 404;
          throw e;
        }
        return (await res.json()).tag_name;
      });
    }
  }

  async function latestPypi(pkg) {
    return retry(async () => {
      const res = await fetch(`https://pypi.org/pypi/${pkg}/json`, { headers: { 'User-Agent': 'scanhub' } });
      if (!res.ok) throw new Error(`PyPI ${res.status}`);
      return (await res.json()).info.version;
    });
  }

  /** Where to get the latest version: { version, url?, name? } */
  async function resolveLatest(item) {
    if (item.source === 'github') {
      const tag = await latestTag(item.repo);
      const v = tag.replace(/^v/, '');
      const name = item.asset(v);
      return { version: v, name, url: `https://github.com/${item.repo}/releases/download/${encodeURIComponent(tag)}/${name}` };
    }
    if (item.source === 'sonar') {
      const v = (await latestTag('SonarSource/sonar-scanner-cli')).replace(/^v/, '');
      const name = `sonar-scanner-cli-${v}-linux-${linuxArch() === 'arm64' ? 'aarch64' : 'x64'}.zip`;
      return { version: v, name, url: `https://binaries.sonarsource.com/Distribution/sonar-scanner-cli/${name}` };
    }
    return { version: await latestPypi(item.pkg) };
  }

  function download(url, dest) {
    return retry(async () => {
      const res = await fetch(url, { headers: { 'User-Agent': 'scanhub' }, redirect: 'follow' });
      if (!res.ok || !res.body) {
        const e = new Error(`Download failed ${res.status}: ${url}`);
        e.permanent = res.status === 404;
        throw e;
      }
      await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(dest));
    });
  }

  async function extract(archive, into) {
    ensureDir(into);
    const r = archive.endsWith('.zip')
      ? await runCmd('unzip', ['-q', '-o', archive, '-d', into])
      : await runCmd('tar', ['-xzf', archive, '-C', into]);
    if (r.code !== 0) throw new Error(`Extract failed: ${tail(r.stderr)}`);
  }

  async function detectVersion(item, bin) {
    const r = await runCmd(bin, item.versionArgs, { timeoutMs: 180000, env: item.env ? item.env() : undefined });
    return versionFrom(r.stdout + '\n' + r.stderr);
  }

  const chmodAll = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const f of fs.readdirSync(dir)) { try { fs.chmodSync(path.join(dir, f), 0o755); } catch { /* ignore */ } }
  };

  // venv scripts have the venv path in their shebang: point them at the final location after the swap
  function relocateVenv(dir, from, to) {
    const bin = path.join(dir, 'venv', 'bin');
    if (!fs.existsSync(bin)) return;
    for (const f of [...fs.readdirSync(bin).map((n) => path.join(bin, n)), path.join(dir, 'venv', 'pyvenv.cfg')]) {
      try {
        const st = fs.lstatSync(f);
        if (!st.isFile() || st.size > 1024 * 1024) continue;
        const text = fs.readFileSync(f, 'latin1');
        if (text.includes(from)) fs.writeFileSync(f, text.split(from).join(to), 'latin1');
      } catch { /* ignore */ }
    }
  }

  /** Build the new version in <id>.new */
  async function build(item, latest, staging) {
    rmrf(staging);
    ensureDir(staging);
    if (latest.url) {
      const tmp = path.join(ensureDir(dirs.uploads), `${item.id}-${Date.now()}-${latest.name}`);
      try {
        await download(latest.url, tmp);
        await extract(tmp, staging);
      } finally {
        rmrf(tmp);
      }
    } else {
      const venv = path.join(staging, 'venv');
      const r1 = await runCmd('python3', ['-m', 'venv', venv], { timeoutMs: 600000 });
      if (r1.code !== 0) throw new Error(`venv creation failed: ${tail(r1.stderr)}`);
      const r2 = await runCmd(path.join(venv, 'bin', 'pip'), ['install', '--quiet', '--disable-pip-version-check', '--no-cache-dir', `${item.pkg}==${latest.version}`], { timeoutMs: 1800000 });
      if (r2.code !== 0) throw new Error(`pip install failed: ${tail(r2.stderr)}`);
    }
    const bin = toolBinIn(staging, item);
    if (!bin) throw new Error(`${item.binName} not found in the installed files`);
    chmodAll(path.dirname(bin));
    if (item.source === 'sonar') chmodAll(path.join(path.dirname(path.dirname(bin)), 'jre', 'bin'));
    if (!(await detectVersion(item, bin))) throw new Error('Installed, but the version check failed, so the version was not changed');
  }

  /** Swap <id>.new into DATA_DIR/tools/<id>; restore the old dir if the new one does not run there */
  async function swap(item, staging) {
    const final = path.join(dirs.tools, item.id);
    const old = path.join(dirs.tools, `${item.id}.old`);
    rmrf(old);
    const hadOld = fs.existsSync(final);
    if (hadOld) fs.renameSync(final, old);
    try {
      fs.renameSync(staging, final);
      if (item.source === 'pip') relocateVenv(final, staging, final);
      const bin = toolBinIn(final, item);
      const version = bin && await detectVersion(item, bin);
      if (!version) throw new Error('The new version does not run after being moved into place');
      rmrf(old);
      return { bin, version };
    } catch (e) {
      rmrf(final);
      if (hadOld) fs.renameSync(old, final);
      throw e;
    }
  }

  /** Install the latest version as an override, unless the version in use is already the latest */
  async function updateOverride(item) {
    if (process.platform !== 'linux') throw new Error('Scanners can only be updated in the Linux container (docker)');
    const current = await row(item.id);
    const inUse = overrideBin(current) ? current.version : (imageBin(item) ? current.image_version : null);
    const latest = await resolveLatest(item);
    if (inUse && versionFrom(latest.version) === versionFrom(inUse)) return { version: inUse, unchanged: true };
    ensureDir(dirs.tools);
    const staging = path.join(dirs.tools, `${item.id}.new`);
    try {
      await build(item, latest, staging);
      const { bin, version } = await lock.withExclusive(item.id, () => swap(item, staging));
      await db.run('UPDATE tools SET installed = 1, bin = ?, version = ?, updated_at = now() WHERE id = ?', bin, version, item.id);
      return { version, from: inUse };
    } finally {
      rmrf(staging);
    }
  }

  async function dropOverride(id) {
    await lock.withExclusive(id, async () => rmrf(path.join(dirs.tools, id)));
    await db.run('UPDATE tools SET installed = 0, bin = NULL, version = NULL, updated_at = now() WHERE id = ?', id);
  }

  const ACTIVE = { install: 'installing', update: 'updating', reset: 'removing', remove: 'removing' };
  function job(id, action) {
    const item = toolById(id);
    if (!item) throw new Error('Unknown scanner');
    const queued = setStatus(id, ACTIVE[action], null);
    return enqueue(async () => {
      await queued;
      try {
        let msg;
        if (action === 'install') {
          // Built in: just enable. Not in the image (local dev): download it.
          if (!(await installedBin(id))) await updateOverride(item);
          await db.run('UPDATE tools SET enabled = 1 WHERE id = ?', id);
          msg = 'Enabled';
        } else if (action === 'update') {
          const r = await updateOverride(item);
          msg = r.unchanged ? `Already the latest version (${r.version})` : `Updated ${r.from ? `${r.from} → ` : ''}${r.version}`;
        } else if (action === 'reset') {
          await dropOverride(id);
          msg = 'Back to the version in the image';
        } else {
          await dropOverride(id);
          await db.run('UPDATE tools SET enabled = 0 WHERE id = ?', id);
          msg = 'Disabled and removed the updated version';
        }
        await setStatus(id, 'idle', null);
        await log(id, action, true, msg);
        return { ok: true };
      } catch (e) {
        const msg = String(e.message || e);
        // A failed update keeps the version in use working
        const usable = await installedBin(id);
        await setStatus(id, usable ? 'idle' : 'error', usable ? `${action === 'update' ? 'Update' : 'Action'} failed, still using the current version: ${msg}` : msg);
        await log(id, action, false, msg);
        return { ok: false, error: msg };
      }
    });
  }

  async function setEnabled(id, on) {
    if (!toolById(id)) throw new Error('Unknown scanner');
    await db.run('UPDATE tools SET enabled = ? WHERE id = ?', on ? 1 : 0, id);
    await log(id, on ? 'enable' : 'disable', true, on ? 'Enabled' : 'Disabled');
  }

  /** Setup: enable exactly these tools */
  async function applySelection(ids) {
    for (const t of CATALOG) {
      const on = ids.includes(t.id);
      await db.run('UPDATE tools SET enabled = ? WHERE id = ?', on ? 1 : 0, t.id);
      if (on && !(await installedBin(t.id))) job(t.id, 'install');
    }
  }

  async function updateDbs() {
    const results = [];
    const nvdApiKey = await effectiveNvdKey(db);
    for (const item of CATALOG) {
      if (!item.updateDb || !(await isEnabled(item.id))) continue;
      const bin = await installedBin(item.id);
      if (!bin) continue;
      const release = await lock.shared(item.id);
      let r;
      try { r = await item.updateDb.call(item, { bin, ctx: { nvdApiKey } }); } finally { release(); }
      const ok = r.code === 0;
      await log(item.id, 'update-db', ok, ok ? 'Vulnerability database updated' : tail(r.stderr || r.stdout) || `exit ${r.code}`);
      results.push({ id: item.id, ok });
    }
    return results;
  }

  // The daily job: update every enabled tool (only when a newer version exists), then the vulnerability DBs
  let updatingAll = null;
  function updateAll() {
    if (updatingAll) return updatingAll;
    updatingAll = (async () => {
      const targets = [];
      for (const t of CATALOG) if ((await isEnabled(t.id)) && (await installedBin(t.id))) targets.push(t);
      const res = await Promise.all(targets.map((t) => job(t.id, 'update')));
      const schedule = await db.getSetting('schedule', {});
      const dbRes = schedule?.updateDb === false ? [] : await enqueue(updateDbs);
      const failed = targets.filter((t, i) => !res[i].ok).map((t) => t.name).concat(dbRes.filter((d) => !d.ok).map((d) => `${toolById(d.id).name} DB`));
      const summary = targets.length === 0 ? 'No scanners enabled'
        : failed.length ? `Failed: ${failed.join(', ')}` : `Checked and updated ${targets.length} scanners`;
      const run = { at: new Date().toISOString(), ok: failed.length === 0, summary };
      await db.setSetting('lastUpdateRun', run);
      return run;
    })().finally(() => { updatingAll = null; });
    return updatingAll;
  }

  /** On boot: image versions, finish an interrupted swap, register overrides found on disk */
  async function reconcile() {
    for (const item of CATALOG) {
      const img = imageBin(item);
      let imageVersion = img ? manifest[item.id] || null : null;
      if (img && !imageVersion) imageVersion = await detectVersion(item, img);
      await db.run('UPDATE tools SET image_version = ? WHERE id = ?', imageVersion, item.id);

      const final = path.join(dirs.tools, item.id);
      const old = path.join(dirs.tools, `${item.id}.old`);
      if (!fs.existsSync(final) && fs.existsSync(old)) fs.renameSync(old, final);
      rmrf(old);
      rmrf(path.join(dirs.tools, `${item.id}.new`));
      const r = await row(item.id);
      const bin = fs.existsSync(final) ? toolBinIn(final, item) : null;
      if (bin && !(r?.installed && r.bin === bin)) {
        const version = await detectVersion(item, bin);
        if (version) await db.run('UPDATE tools SET installed = 1, bin = ?, version = ?, updated_at = COALESCE(updated_at, now()) WHERE id = ?', bin, version, item.id);
      } else if (!bin && r?.installed) {
        await db.run('UPDATE tools SET installed = 0, bin = NULL, version = NULL WHERE id = ?', item.id);
      }
    }
  }

  const logs = async () => (await db.all('SELECT * FROM tool_log ORDER BY id DESC LIMIT 100'))
    .map((l) => ({ at: l.at, tool: l.tool, action: l.action, ok: !!l.ok, message: l.message }));

  return {
    list,
    logs,
    installedBin,
    isEnabled,
    install: (id) => job(id, 'install'),
    update: (id) => job(id, 'update'),
    reset: (id) => job(id, 'reset'),
    remove: (id) => job(id, 'remove'),
    enable: (id) => setEnabled(id, true),
    disable: (id) => setEnabled(id, false),
    applySelection,
    updateAll,
    reconcile,
    sonarConfigured,
  };
}
