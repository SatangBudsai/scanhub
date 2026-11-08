// Setup wizard, scanners and settings
import express from 'express';
import { requireRole } from '../auth.js';
import { CATALOG, TOOL_IDS } from '../tools/catalog.js';
import { ah, bad, notFound } from '../util.js';
import { config } from '../config.js';
import { isTime, readSettings, validSchedule } from '../settings.js';

const catalogItem = (t) => ({ id: t.id, name: t.name, desc: t.desc, needsConfig: !!t.needsConfig });
const URL_RE = /^https?:\/\/\S+$/;

export function setupRoutes({ db, tools }) {
  const r = express.Router();
  r.get('/', ah(async (req, res) => res.json({ done: !!(await db.getSetting('setupDone', false)), catalog: CATALOG.map(catalogItem) })));
  r.post('/', requireRole('ADMIN'), ah(async (req, res) => {
    const ids = Array.isArray(req.body?.tools) ? req.body.tools : [];
    const unknown = ids.find((id) => !TOOL_IDS.includes(id));
    if (unknown) throw bad(`ไม่รู้จัก scanner: ${unknown}`);
    let schedule;
    try { schedule = validSchedule(req.body?.schedule || {}); } catch (e) { throw bad(e.message); }
    await db.setSetting('schedule', schedule);
    await db.setSetting('setupDone', true);
    // Scanners are built into the image: setup only chooses which ones are enabled
    await tools.applySelection([...new Set(ids)]);
    res.json({ ok: true });
  }));
  return r;
}

export function toolRoutes({ tools }) {
  const r = express.Router();
  r.get('/', requireRole('ADMIN', 'SA'), ah(async (req, res) => res.json(await tools.list())));
  r.get('/log', requireRole('ADMIN', 'SA'), ah(async (req, res) => res.json(await tools.logs())));
  r.post('/update-all', requireRole('ADMIN'), (req, res) => {
    tools.updateAll();
    res.json({ ok: true });
  });
  const known = (req) => {
    if (!TOOL_IDS.includes(req.params.id)) throw notFound('ไม่พบ scanner นี้');
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
  r.get('/', requireRole('ADMIN', 'SA'), ah(async (req, res) => res.json(await readSettings(db))));
  r.put('/', requireRole('ADMIN'), ah(async (req, res) => {
    const b = req.body || {};
    // Validate everything first, then save
    const writes = [];
    if (b.serverUrl !== undefined) {
      const u = String(b.serverUrl || '').trim().replace(/\/+$/, '');
      if (u && !URL_RE.test(u)) throw bad('Server URL ต้องขึ้นต้นด้วย http:// หรือ https://');
      writes.push(() => db.setSetting('serverUrl', u || null));
    }
    if (b.retentionDays !== undefined) {
      const n = Number(b.retentionDays);
      if (!Number.isInteger(n) || n < 0 || n > 3650) throw bad('จำนวนวันเก็บข้อมูลต้องเป็น 0–3650');
      writes.push(() => db.setSetting('retentionDays', n));
    }
    if (b.schedule !== undefined) {
      let s;
      try { s = validSchedule(b.schedule, (await readSettings(db)).schedule); } catch (e) { throw bad(e.message); }
      writes.push(() => db.setSetting('schedule', s));
    }
    if (b.scanTime !== undefined) {
      if (!isTime(b.scanTime)) throw bad('เวลาสแกนต้องอยู่ในรูปแบบ HH:MM');
      writes.push(() => db.setSetting('scanTime', b.scanTime));
    }
    // Fields that come from env are read-only: ignored here
    if (b.sonar && !config.sonarFromEnv) {
      if (b.sonar.url !== undefined) {
        const u = String(b.sonar.url || '').trim().replace(/\/+$/, '');
        if (u && !URL_RE.test(u)) throw bad('SonarQube URL ต้องขึ้นต้นด้วย http:// หรือ https://');
        writes.push(() => db.setSetting('sonarUrl', u));
      }
      if (b.sonar.token !== undefined) writes.push(() => setSecret(db, 'sonarToken', b.sonar.token));
    }
    if (b.nvdApiKey !== undefined && !config.nvdFromEnv) writes.push(() => setSecret(db, 'nvdApiKey', b.nvdApiKey));
    for (const w of writes) await w();
    res.json(await readSettings(db));
  }));
  return r;
}
