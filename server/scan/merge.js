import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { sevRank } from '../util.js';

const SNIPPET_AROUND = 3;
const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');
const normVer = (v) => String(v || '').replace(/^(v|go)(?=\d)/, '');

export function redact(secret) {
  const s = String(secret);
  return s.slice(0, 4) + '****';
}

// Mask the value part of a "key: value" / "key = value" line, keeping 4 characters
export function maskValue(line) {
  return line.replace(/([:=]\s*["'`]?)([^\s"'`#,;]{4})([^\s"'`#,;]*)/, (all, pre, head, rest) => (rest.includes('****') || !rest ? all : `${pre}${head}****`));
}

function readLines(src, file, cache) {
  if (!src || !file) return null;
  if (cache.has(file)) return cache.get(file);
  let lines = null;
  try {
    const p = path.resolve(src, file);
    if (p.startsWith(path.resolve(src))) {
      const st = fs.statSync(p);
      if (st.isFile() && st.size < 5 * 1024 * 1024) lines = fs.readFileSync(p, 'utf8').split(/\r?\n/);
    }
  } catch { /* file not in source */ }
  cache.set(file, lines);
  return lines;
}

/**
 * Dedupe raw findings from all tools into one list.
 * Dependencies merge on rule + package + version, everything else on category + file + line.
 * When src is given, reads snippets and uses the source line text in the fingerprint.
 */
export function mergeFindings(raw, { src } = {}) {
  const map = new Map();
  for (const f of raw) {
    const key = f.pkg ? `dep|${f.rule}|${f.pkg}|${normVer(f.version)}` : `${f.category}|${f.file}|${f.line || 0}`;
    let m = map.get(key);
    if (!m) {
      m = {
        severity: f.severity, category: f.category, title: f.title, file: f.file, line: f.line,
        pkg: f.pkg, version: f.version, rules: [], tools: [], fix: f.fix, description: f.description,
        refs: [], secrets: [],
      };
      map.set(key, m);
    } else {
      if (sevRank(f.severity) < sevRank(m.severity)) m.severity = f.severity;
      if (!m.fix && f.fix) m.fix = f.fix;
      if (!m.description && f.description) m.description = f.description;
      if (!m.file && f.file) m.file = f.file;
    }
    if (!m.tools.includes(f.tool)) m.tools.push(f.tool);
    if (f.rule && !m.rules.some((r) => r.tool === f.tool && r.id === f.rule)) m.rules.push({ tool: f.tool, id: f.rule });
    for (const r of f.refs || []) if (!m.refs.includes(r) && m.refs.length < 10) m.refs.push(r);
    if (f.secret && String(f.secret).length >= 4) m.secrets.push(String(f.secret));
  }

  // Secrets must not leak through any snippet, including a neighbour's snippet that shows the same line:
  // every known secret value is replaced everywhere, and every line flagged as a secret is masked.
  const secretValues = [...new Set([...map.values()].flatMap((m) => m.secrets))].sort((a, b) => b.length - a.length);
  const secretLines = new Map();
  for (const m of map.values()) {
    if (m.category !== 'Secret' || !m.line || !m.file) continue;
    if (!secretLines.has(m.file)) secretLines.set(m.file, new Set());
    secretLines.get(m.file).add(m.line);
  }
  const scrub = (s) => {
    let t = String(s || '');
    for (const sec of secretValues) t = t.split(sec).join(redact(sec));
    return t;
  };

  const cache = new Map();
  const out = [];
  for (const m of map.values()) {
    const lines = m.line ? readLines(src, m.file, cache) : null;
    let snippet = null, lineText = '';
    if (lines && m.line <= lines.length) {
      lineText = lines[m.line - 1].trim();
      const start = Math.max(1, m.line - SNIPPET_AROUND);
      const end = Math.min(lines.length, m.line + SNIPPET_AROUND);
      const flagged = secretLines.get(m.file);
      snippet = {
        start,
        lines: lines.slice(start - 1, end).map((l, i) => {
          let t = scrub(l.slice(0, 300));
          if (flagged?.has(start + i)) t = maskValue(t);
          return t;
        }),
        hl: m.line,
      };
    }
    if (secretValues.length) {
      m.title = scrub(m.title);
      m.description = scrub(m.description);
    }
    const ruleKey = m.rules.map((r) => r.id).sort()[0] || '';
    const fingerprint = m.pkg
      ? sha1(`dep|${ruleKey}|${m.pkg}`)
      : sha1(`${m.category}|${m.file}|${lineText || m.line || ruleKey}`);
    out.push({
      fingerprint,
      severity: m.severity,
      category: m.category,
      title: m.title,
      location: m.pkg ? `${m.pkg}@${m.version}` : m.file ? (m.line ? `${m.file}:${m.line}` : m.file) : '',
      file: m.file || '',
      line: m.line || null,
      pkg: m.pkg || '',
      version: m.version || '',
      rules: m.rules,
      tools: m.tools,
      fix: m.fix || '',
      description: m.description || '',
      snippet,
      refs: m.refs,
    });
  }
  out.sort((a, b) => sevRank(a.severity) - sevRank(b.severity) || a.location.localeCompare(b.location));
  return out;
}

/**
 * Mark each finding new / existing against the previous scan, and add fixed ones
 * (present before, gone now). prev = findings rows of the previous scan (or null for the first scan).
 */
export function diffFindings(current, prev, num) {
  const prevOpen = (prev || []).filter((f) => f.status !== 'fixed');
  const byFp = new Map();
  for (const p of prevOpen) if (!byFp.has(p.fingerprint)) byFp.set(p.fingerprint, p);
  const matched = new Set();
  const out = current.map((f) => {
    const p = byFp.get(f.fingerprint);
    if (p) {
      matched.add(f.fingerprint);
      return { ...f, status: 'existing', firstSeenNum: p.firstSeenNum ?? p.first_seen_num ?? num };
    }
    return { ...f, status: 'new', firstSeenNum: num };
  });
  for (const p of prevOpen) {
    if (matched.has(p.fingerprint)) continue;
    matched.add(p.fingerprint);
    out.push({ ...p, status: 'fixed', firstSeenNum: p.firstSeenNum ?? p.first_seen_num ?? null });
  }
  return out;
}

export function summarize(findings) {
  const counts = [0, 0, 0, 0, 0];
  let open = 0, nw = 0, fixed = 0;
  const newBySeverity = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const f of findings) {
    if (f.status === 'fixed') { fixed++; continue; }
    open++;
    counts[sevRank(f.severity)]++;
    if (f.status === 'new') { nw++; newBySeverity[f.severity]++; }
  }
  return { counts, openCount: open, newCount: nw, fixedCount: fixed, newBySeverity };
}
