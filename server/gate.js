// CI gate: decides whether a CI call fails (block) or only reports
import { SEV } from './util.js';

export const DEFAULT_GATE = { mode: 'block', severities: ['critical', 'high'], scope: 'new' };

/** Validate a (partial) gate on top of the current one. Throws Error with a Thai message. */
export function validGate(g, current = DEFAULT_GATE) {
  if (g == null || typeof g !== 'object' || Array.isArray(g)) throw new Error('gate ไม่ถูกต้อง');
  const out = { ...DEFAULT_GATE, ...current };
  if (g.mode !== undefined) {
    if (!['block', 'report'].includes(g.mode)) throw new Error('gate.mode ต้องเป็น block หรือ report');
    out.mode = g.mode;
  }
  if (g.scope !== undefined) {
    if (!['new', 'open'].includes(g.scope)) throw new Error('gate.scope ต้องเป็น new หรือ open');
    out.scope = g.scope;
  }
  if (g.severities !== undefined) {
    if (!Array.isArray(g.severities) || !g.severities.length || g.severities.some((s) => !SEV.includes(s))) {
      throw new Error('gate.severities ต้องเป็นรายการระดับความรุนแรงอย่างน้อย 1 ระดับ');
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
  const what = gate.scope === 'new' ? 'ปัญหาใหม่' : 'ปัญหาที่ยังเปิดอยู่';
  const found = hits.map((s) => `${SEV_LABEL[s]} ${matched[s]}`).join(', ');
  let reason = '';
  if (hits.length) reason = gate.mode === 'block' ? `พบ${what} ${found}` : `พบ${what} ${found} (โหมดรายงานอย่างเดียว ไม่ทำให้ pipeline ล้ม)`;
  return { ...gate, failed: gate.mode === 'block' && hits.length > 0, matched, reason };
}

/** Short plain-text summary for the CI log */
export function summaryText({ repoName, scan, counts, newCount, fixedCount, gate, url }) {
  const head = `ScanHub · ${repoName} · สแกน #${scan.num}`;
  if (scan.status === 'failed') return `${head}\nสแกนไม่สำเร็จ: ${scan.error || 'ไม่ทราบสาเหตุ'}\nดูรายละเอียด: ${url}\n`;
  if (scan.status !== 'done') return `${head}\nยังสแกนไม่เสร็จ (สถานะ ${scan.status}) ดูผลภายหลังที่: ${url}\n`;
  const open = counts.reduce((a, b) => a + b, 0);
  const lines = [
    head,
    `ยังเปิดอยู่ ${open} รายการ (${SEV.map((s, i) => `${SEV_LABEL[s]} ${counts[i]}`).join(' · ')})`,
    `ใหม่ ${newCount} · แก้แล้ว ${fixedCount} เทียบกับสแกนก่อนหน้า`,
  ];
  const rule = `${gate.mode === 'block' ? 'block' : 'report only'} · ${gate.scope === 'new' ? 'เฉพาะปัญหาใหม่' : 'ทุกปัญหาที่เปิดอยู่'} · ${gate.severities.join(', ')}`;
  if (gate.failed) lines.push(`ผลการตรวจ: ไม่ผ่าน (${rule}) ${gate.reason}`);
  else if (gate.reason) lines.push(`ผลการตรวจ: ผ่าน (${rule}) ${gate.reason}`);
  else lines.push(`ผลการตรวจ: ผ่าน (${rule})`);
  lines.push(`ดูผล: ${url}`);
  return lines.join('\n') + '\n';
}
