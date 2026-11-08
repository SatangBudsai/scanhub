import { createScan } from './scan/store.js';
import { readSettings } from './settings.js';

const RETENTION_TIME = '04:30';

/** Current date and HH:MM in the configured time zone */
export function localNow(tz, d = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(d).map((p) => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

/**
 * Daily jobs. Each one runs once per day at (or after) its time; the last run date is stored,
 * so a restart does not run it twice. On first boot a job whose time already passed waits for tomorrow.
 */
export async function startScheduler({ db, tools, queue, runner, tz }) {
  const jobs = [
    {
      key: 'toolUpdate',
      when: async () => { const s = (await readSettings(db)).schedule; return s.enabled ? s.time : null; },
      run: () => tools.updateAll(),
    },
    {
      key: 'repoScans',
      when: async () => (await readSettings(db)).scanTime,
      run: async () => {
        for (const repo of await db.all(`SELECT * FROM repos WHERE schedule = 'daily' AND git_url IS NOT NULL AND git_url <> ''`)) {
          if (queue.isBusy(repo.id)) continue;
          queue.add(await createScan(db, repo, { trigger: 'schedule', branch: repo.branch }), runner.fromGit());
        }
      },
    },
    { key: 'retention', when: async () => RETENTION_TIME, run: () => cleanupOldScans(db) },
  ];

  const lastKey = (k) => `schedLast_${k}`;
  const init = localNow(tz);
  for (const j of jobs) {
    const t = await j.when();
    if ((await db.getSetting(lastKey(j.key), null)) == null) await db.setSetting(lastKey(j.key), t && init.time >= t ? init.date : '');
  }

  let ticking = false;
  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      const now = localNow(tz);
      for (const j of jobs) {
        const t = await j.when();
        if (!t || now.time < t) continue;
        if ((await db.getSetting(lastKey(j.key), '')) === now.date) continue;
        await db.setSetting(lastKey(j.key), now.date);
        Promise.resolve().then(j.run).catch((e) => console.error(`[scheduler] ${j.key} failed:`, e));
      }
    } catch (e) {
      console.error('[scheduler]', e.message);
    } finally {
      ticking = false;
    }
  }
  const timer = setInterval(tick, 30 * 1000);
  timer.unref();
  return { tick, stop: () => clearInterval(timer) };
}

/** Delete scans older than retentionDays, always keeping the latest done scan of each repo */
export async function cleanupOldScans(db) {
  const days = (await readSettings(db)).retentionDays;
  if (!days) return 0;
  const cutoff = new Date(Date.now() - days * 864e5).toISOString();
  return (await db.run(
    `DELETE FROM scans WHERE status IN ('done', 'failed') AND COALESCE(finished_at, created_at) < ?
       AND id NOT IN (SELECT MAX(id) FROM scans WHERE status = 'done' GROUP BY repo_id)`,
    cutoff,
  )).changes;
}
