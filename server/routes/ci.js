// CI API: authenticated with the repo token (Authorization: Bearer shr_...)
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { sha256 } from '../auth.js';
import { config, dirs } from '../config.js';
import { TOOL_IDS } from '../tools/catalog.js';
import { PARSERS } from '../scan/parsers/index.js';
import { createScan, scanSummary } from '../scan/store.js';
import { ah, bad, ensureDir, HttpError, json, notFound, rmrf, SEV } from '../util.js';
import { DEFAULT_GATE, evaluateGate, summaryText } from '../gate.js';
import { getServerUrl } from '../settings.js';

const WAIT_MS = 30 * 60 * 1000;

export function ciRoutes({ db, queue, runner }) {
  const r = express.Router();

  r.use(ah(async (req, res, next) => {
    const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || '');
    const repo = m ? await db.get('SELECT * FROM repos WHERE token_hash = ?', sha256(m[1])) : null;
    if (!repo) throw new HttpError(401, 'token ไม่ถูกต้อง หรือถูกสร้างใหม่แล้ว');
    req.repo = repo;
    next();
  }));

  const scanUrl = async (scan) => `${await getServerUrl(db)}/#repo/${scan.repo_id}/${scan.num}`;
  const parseList = (s, allowed) => String(s || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean).filter((x) => allowed.includes(x));

  /**
   * The gate for this call: the repo's gate, with per-call overrides.
   * fail_on=a,b (compatibility) blocks on new findings at those severities; gate=report never fails.
   */
  function gateFor(req) {
    let gate = { ...DEFAULT_GATE, ...json(req.repo.gate, {}) };
    const failOn = parseList(req.query.fail_on || req.body?.fail_on, SEV);
    if (failOn.length) gate = { mode: 'block', severities: failOn, scope: 'new' };
    const g = String(req.query.gate || '').toLowerCase();
    if (g === 'report' || g === 'block') gate = { ...gate, mode: g };
    return gate;
  }

  async function result(req, scan) {
    const s = scanSummary(scan);
    const newBySeverity = Object.fromEntries(SEV.map((k) => [k, 0]));
    let findings = [];
    if (scan.status === 'done') {
      findings = await db.all('SELECT severity, status FROM findings WHERE scan_id = ?', scan.id);
      for (const f of findings) if (f.status === 'new') newBySeverity[f.severity]++;
    }
    const gate = evaluateGate(gateFor(req), findings);
    if (scan.status !== 'done') gate.failed = false;
    const url = await scanUrl(scan);
    return {
      scanId: scan.id, num: scan.num, status: scan.status, url, counts: s.counts,
      newCount: s.newCount, fixedCount: s.fixedCount, newBySeverity, gate, error: s.error,
      summaryText: summaryText({ repoName: req.repo.name, scan, counts: s.counts, newCount: s.newCount, fixedCount: s.fixedCount, gate, url }),
    };
  }

  // Accept: text/plain (or format=text) returns only summaryText, with the same status code.
  // This is what the generated pipelines print to the CI log.
  async function respond(req, res, scanId) {
    const scan = await db.get('SELECT * FROM scans WHERE id = ?', scanId);
    const body = await result(req, scan);
    const status = scan.status === 'failed' ? 500 : scan.status !== 'done' ? 202 : body.gate.failed ? 422 : 200;
    const wantsText = String(req.query.format || '').toLowerCase() === 'text'
      || String(req.headers.accept || '').trim().toLowerCase().startsWith('text/plain');
    if (wantsText) return res.status(status).type('text/plain; charset=utf-8').send(body.summaryText);
    res.status(status).json(body);
  }

  // Source upload: gzip tar streamed to disk, then scanned on the server
  r.post('/scan', ah(async (req, res) => {
    const limit = config.maxUploadMb * 1024 * 1024;
    if (Number(req.headers['content-length'] || 0) > limit) throw new HttpError(413, `ไฟล์ใหญ่เกิน ${config.maxUploadMb} MB`);
    const tools = parseList(req.query.tools, TOOL_IDS);
    const file = path.join(ensureDir(dirs.uploads), `src-${req.repo.id}-${Date.now()}-${Math.random().toString(36).slice(2)}.tgz`);
    let size = 0;
    const counter = new Transform({
      transform(chunk, enc, cb) {
        size += chunk.length;
        if (size > limit) return cb(new HttpError(413, `ไฟล์ใหญ่เกิน ${config.maxUploadMb} MB`));
        cb(null, chunk);
      },
    });
    try {
      await pipeline(req, counter, fs.createWriteStream(file));
    } catch (e) {
      rmrf(file);
      throw e instanceof HttpError ? e : bad(`อัปโหลดไม่สำเร็จ: ${e.message}`);
    }
    if (size === 0) { rmrf(file); throw bad('ไม่ได้รับไฟล์ ส่ง tar.gz ของ source มาใน body'); }
    const scan = await createScan(db, req.repo, { trigger: 'ci', branch: req.query.branch, commit: req.query.commit, tools: tools.length ? tools : null });
    queue.add(scan, runner.fromUpload(file));
    if (!['1', 'true', 'yes'].includes(String(req.query.wait || '').toLowerCase())) {
      return res.status(202).json({ scanId: scan.id, num: scan.num, status: scan.status, url: await scanUrl(scan) });
    }
    req.setTimeout(WAIT_MS + 60000);
    res.setTimeout(WAIT_MS + 60000);
    await queue.waitFor(scan.id, WAIT_MS);
    await respond(req, res, scan.id);
  }));

  // Reports from scanners that already ran in CI
  r.post('/reports', express.json({ limit: `${config.maxUploadMb}mb` }), ah(async (req, res) => {
    const b = req.body || {};
    const reports = Array.isArray(b.reports) ? b.reports : [];
    if (!reports.length) throw bad('ต้องส่ง reports อย่างน้อย 1 รายการ');
    const unknown = reports.find((x) => !PARSERS[x?.tool]);
    if (unknown) throw bad(`ไม่รู้จักรูปแบบรายงาน: ${unknown?.tool}. ใช้ได้: ${Object.keys(PARSERS).join(', ')}`);
    const scan = await createScan(db, req.repo, { trigger: 'upload', branch: b.branch || req.query.branch, commit: b.commit || req.query.commit });
    await runner.ingestReports(scan.id, reports);
    await respond(req, res, scan.id);
  }));

  r.get('/scans/:id', ah(async (req, res) => {
    const id = Number(req.params.id);
    const s = Number.isInteger(id) ? await db.get('SELECT * FROM scans WHERE id = ? AND repo_id = ?', id, req.repo.id) : null;
    if (!s) throw notFound('ไม่พบผลสแกน');
    res.json({ ...scanSummary(s), url: await scanUrl(s) });
  }));

  return r;
}
