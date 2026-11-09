// CI gate: decides whether a CI call fails (block) or only reports
import { SEV } from './util.js';

export const DEFAULT_GATE = { mode: 'block', severities: ['critical', 'high'], scope: 'new' };

/** Validate a (partial) gate on top of the current one. Throws Error with a Thai message. */
export function validGate(g, current = DEFAULT_GATE) {
  if (g == null || typeof g !== 'object' || Array.isArray(g)) throw new Error('Invalid gate');
  const out = { ...DEFAULT_GATE, ...current };
  if (g.mode !== undefined) {
    if (!['block', 'report'].includes(g.mode)) throw new Error('gate.mode must be block or report');
    out.mode = g.mode;
  }
  if (g.scope !== undefined) {
    if (!['new', 'open'].includes(g.scope)) throw new Error('gate.scope must be new or open');
    out.scope = g.scope;
  }
  if (g.severities !== undefined) {
    if (!Array.isArray(g.severities) || !g.severities.length || g.severities.some((s) => !SEV.includes(s))) {
      throw new Error('gate.severities must list at least 1 severity');
    }
    out.severities = SEV.filter((s) => g.severities.includes(s));
  }
  return out;
}

const SEV_LABEL = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low', info: 'Info' };

/**
 * Apply a gate to the findings of a done scan.
 * findings: [{severity, status}] (fixed ones are ignored)
 */
export function evaluateGate(gate, findings) {
  const matched = Object.fromEntries(SEV.map((s) => [s, 0]));
  for (const f of findings) {
    if (f.status === 'fixed' || !gate.severities.includes(f.severity)) continue;
    if (gate.scope === 'new' && f.status !== 'new') continue;
    matched[f.severity]++;
  }
  const hits = SEV.filter((s) => matched[s] > 0);
  const what = gate.scope === 'new' ? 'new issues' : 'open issues';
  const found = hits.map((s) => `${SEV_LABEL[s]} ${matched[s]}`).join(', ');
  let reason = '';
  if (hits.length) reason = gate.mode === 'block' ? `Found ${what}: ${found}` : `Found ${what}: ${found} (report-only mode, the pipeline does not fail)`;
  return { ...gate, failed: gate.mode === 'block' && hits.length > 0, matched, reason };
}

/** Short plain-text summary for the CI log */
export function summaryText({ repoName, scan, counts, newCount, fixedCount, gate, url }) {
  const head = `ScanHub · ${repoName} · scan #${scan.num}`;
  if (scan.status === 'failed') return `${head}\nScan failed: ${scan.error || 'unknown reason'}\nDetails: ${url}\n`;
  if (scan.status !== 'done') return `${head}\nScan not finished yet (status ${scan.status}). See results later at: ${url}\n`;
  const open = counts.reduce((a, b) => a + b, 0);
  const lines = [
    head,
    `Open:    ${open} issues (${SEV.map((s, i) => `${SEV_LABEL[s]} ${counts[i]}`).join(' · ')})`,
    `Changes: ${newCount} new · ${fixedCount} fixed since the previous scan`,
  ];
  const rule = `${gate.mode === 'block' ? 'block' : 'report only'} · ${gate.scope === 'new' ? 'new issues only' : 'all open issues'} · ${gate.severities.join(', ')}`;
  if (gate.failed) lines.push(`Gate:    FAILED (${rule}) ${gate.reason}`);
  else if (gate.reason) lines.push(`Gate:    PASSED (${rule}) ${gate.reason}`);
  else lines.push(`Gate:    PASSED (${rule})`);
  lines.push(`Results: ${url}`);
  return lines.join('\n') + '\n';
}
