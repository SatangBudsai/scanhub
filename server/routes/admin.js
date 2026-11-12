// Setup wizard, scanners and settings
import express from 'express';
import { requireRole } from '../auth.js';
import { CATALOG, TOOL_IDS } from '../tools/catalog.js';
import { ah, bad, notFound } from '../util.js';
import { config } from '../config.js';
import { effectiveSemgrep, isTime, readSettings, semgrepWrites, validSchedule } from '../settings.js';

const catalogItem = (t) => ({ id: t.id, name: t.name, desc: t.desc, needsConfig: !!t.needsConfig });
const URL_RE = /^https?:\/\/\S+$/;

export function setupRoutes({ db, tools }) {
  const r = express.Router();
  r.get('/', ah(async (req, res) => res.json({ done: !!(await db.getSetting('setupDone', false)), catalog: CATALOG.map(catalogItem) })));
  r.post('/', requireRole('ADMIN'), ah(async (req, res) => {
    const ids = Array.isArray(req.body?.tools) ? req.body.tools : [];
    const unknown = ids.find((id) => !TOOL_IDS.includes(id));
    if (unknown) throw bad(`Unknown scanner: ${unknown}`);
    let schedule;
    try { schedule = validSchedule(req.body?.schedule || {}); } catch (e) { throw bad(e.message); }
    // Optional Semgrep rules choice from the wizard (only the installer can accept the rules license)
    let semgrep = [];
    if (req.body?.semgrep !== undefined && !config.semgrepFromEnv) {
      try { semgrep = semgrepWrites(req.body.semgrep, await effectiveSemgrep(db), req.user?.username); } catch (e) { throw bad(e.message); }
    }
    await db.setSetting('schedule', schedule);
    for (const [k, v] of semgrep) await db.setSetting(k, v);
    await db.setSetting('setupDone', true);
    // Scanners are built into the image: setup only chooses which ones are enabled
    await tools.applySelection([...new Set(ids)]);
    res.json({ ok: true });
  }));
  return r;
}

export function toolRoutes({ tools }) {
  const r = express.Router();
  r.get('/', requireRole('ADMIN', 'MAINTAINER'), ah(async (req, res) => res.json(await tools.list())));
  r.get('/log', requireRole('ADMIN', 'MAINTAINER'), ah(async (req, res) => res.json(await tools.logs())));
  r.post('/update-all', requireRole('ADMIN'), (req, res) => {
    tools.updateAll();
    res.json({ ok: true });
  });
  const known = (req) => {
    if (!TOOL_IDS.includes(req.params.id)) throw notFound('Scanner not found');
    return req.params.id;
  };
  r.post('/:id/install', requireRole('ADMIN'), (req, res) => { tools.install(known(req)); res.json({ ok: true }); });
  r.post('/:id/update', requireRole('ADMIN'), (req, res) => { tools.update(known(req)); res.json({ ok: true }); });
  r.post('/:id/reset', requireRole('ADMIN'), (req, res) => { tools.reset(known(req)); res.json({ ok: true }); });
  r.post('/:id/enable', requireRole('ADMIN'), ah(async (req, res) => { await tools.enable(known(req)); res.json({ ok: true }); }));
  r.post('/:id/disable', requireRole('ADMIN'), ah(async (req, res) => { await tools.disable(known(req)); res.json({ ok: true }); }));
  // DELETE = disable + drop the updated version
  r.delete('/:id', requireRole('ADMIN'), (req, res) => { tools.remove(known(req)); res.json({ ok: true }); });
  return r;
}

// Secret-like settings: empty string keeps the stored value, null clears it
async function setSecret(db, key, v) {
  if (v === null) await db.setSetting(key, '');
  else if (typeof v === 'string' && v.trim()) await db.setSetting(key, v.trim());
}

export function settingsRoutes({ db }) {
  const r = express.Router();
  r.get('/', requireRole('ADMIN', 'MAINTAINER'), ah(async (req, res) => res.json(await readSettings(db))));
  r.put('/', requireRole('ADMIN'), ah(async (req, res) => {
    const b = req.body || {};
    // Validate everything first, then save
    const writes = [];
    if (b.serverUrl !== undefined) {
      const u = String(b.serverUrl || '').trim().replace(/\/+$/, '');
      if (u && !URL_RE.test(u)) throw bad('Server URL must start with http:// or https://');
      writes.push(() => db.setSetting('serverUrl', u || null));
    }
    if (b.retentionDays !== undefined) {
      const n = Number(b.retentionDays);
      if (!Number.isInteger(n) || n < 0 || n > 3650) throw bad('Retention days must be 0–3650');
      writes.push(() => db.setSetting('retentionDays', n));
    }
    if (b.schedule !== undefined) {
      let s;
      try { s = validSchedule(b.schedule, (await readSettings(db)).schedule); } catch (e) { throw bad(e.message); }
      writes.push(() => db.setSetting('schedule', s));
    }
    if (b.scanTime !== undefined) {
      if (!isTime(b.scanTime)) throw bad('Scan time must be in HH:MM format');
      writes.push(() => db.setSetting('scanTime', b.scanTime));
    }
    // Fields that come from env are read-only: ignored here
    if (b.sonar && !config.sonarFromEnv) {
      if (b.sonar.url !== undefined) {
        const u = String(b.sonar.url || '').trim().replace(/\/+$/, '');
        if (u && !URL_RE.test(u)) throw bad('SonarQube URL must start with http:// or https://');
        writes.push(() => db.setSetting('sonarUrl', u));
      }
      if (b.sonar.token !== undefined) writes.push(() => setSecret(db, 'sonarToken', b.sonar.token));
    }
    if (b.semgrep !== undefined && !config.semgrepFromEnv) {
      let sw;
      try { sw = semgrepWrites(b.semgrep, await effectiveSemgrep(db), req.user?.username); } catch (e) { throw bad(e.message); }
      for (const [k, v] of sw) writes.push(() => db.setSetting(k, v));
    }
    if (b.nvdApiKey !== undefined && !config.nvdFromEnv) writes.push(() => setSecret(db, 'nvdApiKey', b.nvdApiKey));
    for (const w of writes) await w();
    res.json(await readSettings(db));
  }));
  return r;
}
