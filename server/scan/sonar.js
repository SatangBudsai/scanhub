import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, runCmd, tail } from '../util.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Run sonar-scanner against an existing SonarQube server and read back issues + hotspots. */
export async function runSonar({ bin, src, out, repo, url, token }) {
  const key = `scanhub_${repo.name}`.replace(/[^a-zA-Z0-9_.:-]/g, '_');
  const work = path.join(out, 'sonar-work');
  const emptyBin = ensureDir(path.join(out, 'sonar-empty-classes'));
  const r = await runCmd(bin, [
    `-Dsonar.projectKey=${key}`, `-Dsonar.projectName=${repo.name}`, '-Dsonar.sources=.',
    `-Dsonar.host.url=${url}`, `-Dsonar.token=${token}`,
    '-Dsonar.scm.disabled=true', `-Dsonar.working.directory=${work}`, `-Dsonar.java.binaries=${emptyBin}`,
  ], { cwd: src, timeoutMs: 30 * 60 * 1000 });
  const taskFile = path.join(work, 'report-task.txt');
  if (r.code !== 0 || !fs.existsSync(taskFile)) {
    return { error: tail(r.stdout.split('\n').filter((l) => /ERROR/.test(l)).join('\n') || r.stderr || r.stdout) || `exit ${r.code}` };
  }
  const task = Object.fromEntries(fs.readFileSync(taskFile, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => {
    const i = l.indexOf('=');
    return [l.slice(0, i), l.slice(i + 1)];
  }));
  const headers = { Authorization: 'Basic ' + Buffer.from(`${token}:`).toString('base64') };
  const api = async (p) => {
    const res = await fetch(url + p, { headers });
    if (!res.ok) throw Object.assign(new Error(`SonarQube API ${res.status} ${p.split('?')[0]}`), { status: res.status });
    return res.json();
  };

  // Wait for the server to finish processing the report
  const deadline = Date.now() + 15 * 60 * 1000;
  for (;;) {
    const t = await api(`/api/ce/task?id=${encodeURIComponent(task.ceTaskId)}`);
    const st = t.task?.status;
    if (st === 'SUCCESS') break;
    if (st === 'FAILED' || st === 'CANCELED') return { error: `SonarQube ประมวลผลไม่สำเร็จ: ${t.task?.errorMessage || st}` };
    if (Date.now() > deadline) return { error: 'รอ SonarQube ประมวลผลนานเกิน 15 นาที' };
    await sleep(3000);
  }

  const issues = [];
  let param = 'components';
  for (let p = 1; p <= 20; p++) {
    let page;
    try {
      page = await api(`/api/issues/search?${param}=${encodeURIComponent(key)}&resolved=false&ps=500&p=${p}`);
    } catch (e) {
      if (e.status === 400 && param === 'components' && p === 1) { param = 'componentKeys'; p--; continue; }
      throw e;
    }
    issues.push(...(page.issues || []));
    if (p * 500 >= (page.paging?.total ?? page.total ?? 0)) break;
  }
  const hotspots = [];
  for (let p = 1; p <= 20; p++) {
    let page;
    try {
      page = await api(`/api/hotspots/search?projectKey=${encodeURIComponent(key)}&status=TO_REVIEW&ps=500&p=${p}`);
    } catch { break; }
    hotspots.push(...(page.hotspots || []));
    if (p * 500 >= (page.paging?.total ?? 0)) break;
  }
  return { data: { issues, hotspots } };
}
