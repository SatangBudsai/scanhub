/** FIFO scan queue with a concurrency limit, plus waiting for a scan to finish. */
export function createQueue(db, runner, concurrency) {
  const pending = [];
  let active = 0;
  const waiters = new Map();
  const activeRepos = new Map();

  function finish(scanId) {
    const list = waiters.get(scanId) || [];
    waiters.delete(scanId);
    list.forEach((fn) => fn());
  }

  function pump() {
    while (active < concurrency && pending.length) {
      const job = pending.shift();
      active++;
      activeRepos.set(job.repoId, (activeRepos.get(job.repoId) || 0) + 1);
      runner.execute(job.scanId, job.prepare).finally(() => {
        active--;
        const n = activeRepos.get(job.repoId) - 1;
        if (n > 0) activeRepos.set(job.repoId, n); else activeRepos.delete(job.repoId);
        finish(job.scanId);
        pump();
      });
    }
  }

  return {
    add(scan, prepare) {
      pending.push({ scanId: scan.id, repoId: scan.repo_id, prepare });
      pump();
    },
    /** Resolves when the scan is done/failed or the timeout passes. */
    async waitFor(scanId, timeoutMs) {
      const done = new Promise((resolve) => {
        const t = setTimeout(resolve, timeoutMs);
        const list = waiters.get(scanId) || [];
        list.push(() => { clearTimeout(t); resolve(); });
        waiters.set(scanId, list);
      });
      // Register first, then check, so a finish in between is not missed
      const st = (await db.get('SELECT status FROM scans WHERE id = ?', scanId))?.status;
      if (st === 'done' || st === 'failed') { finish(scanId); return; }
      return done;
    },
    isBusy: (repoId) => activeRepos.has(repoId) || pending.some((j) => j.repoId === repoId),
  };
}
