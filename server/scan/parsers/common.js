// Shared helpers for report parsers. A parser returns "raw findings":
// { tool, severity, category, title, file, line, pkg, version, rule, fix, description, refs, secret? }

export const CATEGORIES = ['Vulnerability', 'Secret', 'Bug', 'Code smell', 'Misconfiguration', 'Security hotspot'];

const SEV_MAP = {
  critical: 'critical', blocker: 'critical',
  high: 'high', error: 'high',
  medium: 'medium', moderate: 'medium', major: 'medium', warning: 'medium',
  low: 'low', minor: 'low', note: 'low',
  info: 'info', informational: 'info', negligible: 'info', unknown: 'info', none: 'info',
};

export function normSev(s, fallback = 'medium') {
  if (s == null || s === '') return fallback;
  return SEV_MAP[String(s).trim().toLowerCase()] || fallback;
}

// Severity from a CVSS-like score (SARIF security-severity, CVSS base score)
export function sevFromScore(score) {
  const n = Number(score);
  if (!Number.isFinite(n)) return null;
  if (n >= 9) return 'critical';
  if (n >= 7) return 'high';
  if (n >= 4) return 'medium';
  if (n > 0) return 'low';
  return 'info';
}

// Make a path relative to the scanned source and use forward slashes
export function relPath(p, src) {
  if (!p) return '';
  let s = String(p).replace(/\\/g, '/');
  if (s.startsWith('file://')) s = s.slice(7);
  if (src) {
    const base = String(src).replace(/\\/g, '/').replace(/\/+$/, '');
    if (s.startsWith(base + '/')) s = s.slice(base.length + 1);
    else if (s === base) s = '';
  }
  return s.replace(/^\.\//, '').replace(/^\/+/, '');
}

export function toLine(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export function refsOf(...lists) {
  const out = [];
  for (const l of lists.flat()) {
    const u = typeof l === 'string' ? l : l && (l.url || l.href);
    if (u && /^https?:\/\//.test(u) && !out.includes(u)) out.push(u);
  }
  return out.slice(0, 10);
}

export function clip(s, n = 4000) {
  if (s == null) return '';
  const t = String(s).trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

export function finding(f) {
  return {
    tool: f.tool,
    severity: f.severity || 'medium',
    category: CATEGORIES.includes(f.category) ? f.category : 'Bug',
    title: clip(f.title || f.rule || 'ไม่มีชื่อ', 300),
    file: f.file || '',
    line: toLine(f.line),
    pkg: f.pkg || '',
    version: f.version || '',
    rule: f.rule ? String(f.rule) : '',
    fix: clip(f.fix, 1000),
    description: clip(f.description),
    refs: f.refs || [],
    secret: f.secret || undefined,
  };
}
