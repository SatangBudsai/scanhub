// Which branches, tags and pull requests a repo scans from CI, and which earlier scan each one is compared with.
//   branch: the previous scan of the same branch
//   pr:     the latest scan of the target branch, so "new" means introduced by the pull request
//   tag:    the previous tag in the same pattern, so sit_v1.2 compares with sit_v1.1, not uat_v1.1
import { json } from '../util.js';

export const REF_KINDS = ['branch', 'tag', 'pr'];
export const DEFAULT_REFS = { branches: [], tags: [], prs: true };
const PATTERN_RE = /^[A-Za-z0-9._/*+@-]{1,100}$/;
const MAX_PATTERNS = 20;

/** `*` matches any text (slashes too), everything else is literal. release/* matches release/1.0 */
const globRe = (p) => new RegExp('^' + p.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
export const firstMatch = (patterns, name) => patterns.find((p) => globRe(p).test(name)) || null;

/** The repo's settings, with the main branch filled in when no branch pattern is set */
export function refsOf(repo) {
  const r = { ...DEFAULT_REFS, ...json(repo.scan_refs, {}) };
  return { branches: r.branches || [], tags: r.tags || [], prs: r.prs !== false, mainBranch: repo.branch || 'main' };
}
export const branchPatterns = (refs) => (refs.branches.length ? refs.branches : [refs.mainBranch]);

/** Accepts arrays or comma / space separated text. Throws a Thai message on bad input. */
export function validRefs(input, current = DEFAULT_REFS) {
  const b = input || {};
  const list = (v, label) => {
    const arr = (Array.isArray(v) ? v : String(v || '').split(/[\s,]+/)).map((x) => String(x).trim()).filter(Boolean);
    const uniq = [...new Set(arr)];
    if (uniq.length > MAX_PATTERNS) throw new Error(`${label}ใส่ได้ไม่เกิน ${MAX_PATTERNS} รายการ`);
    const bad = uniq.find((x) => !PATTERN_RE.test(x));
    if (bad) throw new Error(`${label} "${bad}" ใช้ได้เฉพาะ a-z A-Z 0-9 . _ - / + @ และ *`);
    return uniq;
  };
  return {
    branches: b.branches !== undefined ? list(b.branches, 'Branch') : current.branches || [],
    tags: b.tags !== undefined ? list(b.tags, 'Tag') : current.tags || [],
    prs: b.prs !== undefined ? !!b.prs : current.prs !== false,
  };
}

/** Should CI scan this ref? Returns { scan, group, reason } */
export function shouldScan(repo, kind, name) {
  const refs = refsOf(repo);
  if (kind === 'pr') return refs.prs ? { scan: true, group: '' } : { scan: false, reason: 'repo นี้ปิดการสแกน Pull Request ไว้' };
  if (kind === 'tag') {
    const group = firstMatch(refs.tags, name);
    if (group) return { scan: true, group };
    return { scan: false, reason: refs.tags.length ? `tag ${name} ไม่ตรงกับ ${refs.tags.join(', ')}` : 'repo นี้ไม่ได้ตั้งให้สแกน tag' };
  }
  const pats = branchPatterns(refs);
  return firstMatch(pats, name) ? { scan: true, group: '' } : { scan: false, reason: `branch ${name} ไม่ตรงกับ ${pats.join(', ')}` };
}

/** Normalize the kind CI sends. Unknown or missing = null (old pipelines: scan as a branch, no filter) */
export function parseKind(v) {
  const k = String(v || '').trim().toLowerCase();
  if (k === 'mr' || k === 'pull_request' || k === 'merge_request') return 'pr';
  return REF_KINDS.includes(k) ? k : null;
}

/**
 * The history line a scan belongs to: one per branch, one per PR source branch,
 * one per tag pattern (a tag that matched no pattern is its own line).
 */
export const lineOf = (s) => ({ kind: s.ref_type || 'branch', name: s.ref_type === 'tag' && s.ref_group ? s.ref_group : s.branch || '' });
export const LINE_SQL = `CASE WHEN ref_type = 'tag' AND ref_group <> '' THEN ref_group ELSE branch END`;

/** The earlier scan this one is compared with (see the top of this file) */
export function baselineScan(q, scan, repo) {
  const base = `SELECT * FROM scans WHERE repo_id = ? AND status = 'done' AND num < ?`;
  if (scan.ref_type === 'pr') {
    return q.get(`${base} AND ref_type = 'branch' AND branch = ? ORDER BY num DESC LIMIT 1`, scan.repo_id, scan.num, scan.base_branch || repo.branch || 'main');
  }
  if (scan.ref_type === 'tag') {
    return scan.ref_group
      ? q.get(`${base} AND ref_type = 'tag' AND ref_group = ? ORDER BY num DESC LIMIT 1`, scan.repo_id, scan.num, scan.ref_group)
      : q.get(`${base} AND ref_type = 'tag' AND branch = ? ORDER BY num DESC LIMIT 1`, scan.repo_id, scan.num, scan.branch);
  }
  return q.get(`${base} AND ref_type = 'branch' AND branch = ? ORDER BY num DESC LIMIT 1`, scan.repo_id, scan.num, scan.branch || repo.branch || 'main');
}
