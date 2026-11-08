import { json, nowIso } from '../util.js';
import { diffFindings, summarize } from './merge.js';
import { baselineScan } from './refs.js';

export function scanSummary(s) {
  return {
    id: s.id, num: s.num, status: s.status, trigger: s.trigger, branch: s.branch || '', commit: s.commit_sha || '',
    refType: s.ref_type || 'branch', baseBranch: s.base_branch || '', refGroup: s.ref_group || '',
    startedAt: s.started_at || null, finishedAt: s.finished_at || null, durationMs: s.duration_ms ?? null,
    counts: json(s.counts, [0, 0, 0, 0, 0]), openCount: s.open_count, newCount: s.new_count, fixedCount: s.fixed_count,
    error: s.error || null,
  };
}

export function rowToFinding(f) {
  return {
    id: f.id, fingerprint: f.fingerprint, severity: f.severity, category: f.category, title: f.title,
    location: f.location || '', file: f.file || '', line: f.line ?? null, pkg: f.pkg || '', version: f.version || '',
    rules: json(f.rules, []), tools: json(f.tools, []), fix: f.fix || '', description: f.description || '',
    snippet: json(f.snippet, null), refs: json(f.refs, []), status: f.status, firstSeenNum: f.first_seen_num ?? null,
  };
}

/** refType: branch | tag | pr. base: target branch of a PR. group: the tag pattern the tag matched. */
export async function createScan(db, repo, { trigger, branch, commit, tools, refType = 'branch', base = '', group = '' }) {
  return db.tx(async (q) => {
    // Lock the repo row so concurrent scans get distinct numbers
    await q.get('SELECT id FROM repos WHERE id = ? FOR UPDATE', repo.id);
    const num = ((await q.get('SELECT MAX(num) AS n FROM scans WHERE repo_id = ?', repo.id))?.n || 0) + 1;
    return q.get(
      'INSERT INTO scans (repo_id, num, status, trigger, branch, commit_sha, tools_req, ref_type, base_branch, ref_group) VALUES (?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?, ?) RETURNING *',
      repo.id, num, 'queued', trigger, String(branch || repo.branch || '').slice(0, 200), commit || '', tools ? JSON.stringify(tools) : null,
      refType, refType === 'pr' ? String(base || repo.branch || '').slice(0, 200) : '', refType === 'tag' ? group : '',
    );
  });
}

/** The earlier scan this one is diffed against: same branch, PR target branch, or previous tag in the same pattern */
export async function previousDoneScan(q, scan) {
  const repo = await q.get('SELECT branch FROM repos WHERE id = ?', scan.repo_id);
  return baselineScan(q, scan, repo || {});
}

/** Diff merged findings against the previous scan and save everything in one transaction. */
export async function saveResults(db, scanId, merged, runs) {
  return db.tx(async (q) => {
    const scan = await q.get('SELECT * FROM scans WHERE id = ?', scanId);
    const prev = await previousDoneScan(q, scan);
    const prevFindings = prev ? (await q.all('SELECT * FROM findings WHERE scan_id = ?', prev.id)).map(rowToFinding) : null;
    const all = diffFindings(merged, prevFindings, scan.num);
    const sum = summarize(all);
    const finished = nowIso();
    const started = scan.started_at || finished;
    await q.run('DELETE FROM findings WHERE scan_id = ?', scan.id);
    // Batch inserts: one statement per 200 findings
    const COLS = 19;
    for (let i = 0; i < all.length; i += 200) {
      const chunk = all.slice(i, i + 200);
      const values = chunk.map(() => `(${Array(COLS).fill('?').join(', ')})`).join(', ');
      const params = chunk.flatMap((f) => [
        scan.id, scan.repo_id, f.fingerprint, f.severity, f.category, f.title, f.location || '', f.file || '', f.line ?? null,
        f.pkg || '', f.version || '', JSON.stringify(f.rules || []), JSON.stringify(f.tools || []), f.fix || '', f.description || '',
        f.snippet ? JSON.stringify(f.snippet) : null, JSON.stringify(f.refs || []), f.status, f.firstSeenNum ?? null,
      ]);
      await q.run(
        `INSERT INTO findings (scan_id, repo_id, fingerprint, severity, category, title, location, file, line, pkg, version, rules, tools, fix, description, snippet, refs, status, first_seen_num)
         VALUES ${values}`,
        ...params,
      );
    }
    await q.run(
      `UPDATE scans SET status = 'done', finished_at = ?, started_at = ?, duration_ms = ?, counts = ?::jsonb, open_count = ?, new_count = ?, fixed_count = ?, runs = ?::jsonb, error = NULL WHERE id = ?`,
      finished, started, Date.parse(finished) - Date.parse(started), JSON.stringify(sum.counts), sum.openCount, sum.newCount, sum.fixedCount,
      JSON.stringify(runs), scan.id,
    );
    return sum;
  });
}

export async function failScan(db, scanId, error, runs) {
  const s = await db.get('SELECT started_at FROM scans WHERE id = ?', scanId);
  const finished = nowIso();
  await db.run(
    `UPDATE scans SET status = 'failed', finished_at = ?, duration_ms = ?, error = ?, runs = COALESCE(?::jsonb, runs) WHERE id = ?`,
    finished, s?.started_at ? Date.parse(finished) - Date.parse(s.started_at) : null, String(error).slice(0, 1000),
    runs ? JSON.stringify(runs) : null, scanId,
  );
}
