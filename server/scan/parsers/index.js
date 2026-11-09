import { CATEGORIES, finding, normSev, refsOf, relPath, sevFromScore } from './common.js';

export { CATEGORIES };

/* ---------- Trivy: trivy fs --format json ---------- */
export function parseTrivy(data, { src } = {}) {
  const out = [];
  for (const r of data?.Results || []) {
    const file = relPath(r.Target, src);
    for (const v of r.Vulnerabilities || []) {
      out.push(finding({
        tool: 'trivy', category: 'Vulnerability', severity: normSev(v.Severity, 'info'),
        title: v.Title || `${v.VulnerabilityID} in ${v.PkgName}`,
        file, pkg: v.PkgName, version: v.InstalledVersion, rule: v.VulnerabilityID,
        fix: v.FixedVersion ? `Upgrade ${v.PkgName} to ${v.FixedVersion.split(',')[0].trim()}` : '',
        description: v.Description, refs: refsOf(v.PrimaryURL, v.References || []),
      }));
    }
    for (const m of r.Misconfigurations || []) {
      if (m.Status && m.Status !== 'FAIL') continue;
      out.push(finding({
        tool: 'trivy', category: 'Misconfiguration', severity: normSev(m.Severity),
        title: m.Title || m.Message || m.ID, file, line: m.CauseMetadata?.StartLine,
        rule: m.AVDID || m.ID, fix: m.Resolution,
        description: [m.Description, m.Message].filter(Boolean).join('\n\n'),
        refs: refsOf(m.PrimaryURL, m.References || []),
      }));
    }
    for (const s of r.Secrets || []) {
      out.push(finding({
        tool: 'trivy', category: 'Secret', severity: normSev(s.Severity, 'high'),
        title: s.Title || `Secret found (${s.RuleID})`, file, line: s.StartLine, rule: s.RuleID,
        fix: 'Remove the secret from the code and git history, then rotate it right away',
        description: s.Category ? `Category: ${s.Category}` : '',
      }));
    }
  }
  return out;
}

/* ---------- Semgrep: semgrep scan --json ---------- */
function semgrepCategory(r) {
  const md = r.extra?.metadata || {};
  const cwe = [].concat(md.cwe || []).join(' ');
  const id = String(r.check_id || '').toLowerCase();
  if (/cwe-798|cwe-259|cwe-321/i.test(cwe) || /secret|hardcoded|credential|api[-_]?key/.test(id)) return 'Secret';
  const cat = String(md.category || '').toLowerCase();
  if (cat === 'security') return 'Vulnerability';
  if (cat === 'correctness') return 'Bug';
  if (cat) return 'Code smell';
  return 'Bug';
}
export function parseSemgrep(data, { src } = {}) {
  return (data?.results || []).map((r) => {
    const md = r.extra?.metadata || {};
    let severity = { ERROR: 'high', WARNING: 'medium', INFO: 'low' }[String(r.extra?.severity || '').toUpperCase()] || 'medium';
    const category = semgrepCategory(r);
    if (severity === 'high' && category !== 'Code smell' && String(md.confidence).toUpperCase() === 'HIGH' && String(md.impact).toUpperCase() === 'HIGH') severity = 'critical';
    const shortId = String(r.check_id || '').split('.').pop();
    return finding({
      tool: 'semgrep', category, severity,
      title: (r.extra?.message || shortId).split('\n')[0],
      file: relPath(r.path, src), line: r.start?.line, rule: r.check_id,
      fix: r.extra?.fix ? `Fix: ${r.extra.fix}` : '',
      description: r.extra?.message, refs: refsOf(md.references || [], md.source),
    });
  });
}

/* ---------- Gitleaks: gitleaks dir --report-format json ---------- */
export function parseGitleaks(data, { src } = {}) {
  return (Array.isArray(data) ? data : []).map((g) => finding({
    tool: 'gitleaks', category: 'Secret', severity: 'critical',
    title: g.Description || `Secret found (${g.RuleID})`,
    file: relPath(g.File, src), line: g.StartLine, rule: g.RuleID,
    fix: 'Remove the secret from the code and git history, then rotate it right away',
    description: g.Commit ? `Found in commit ${String(g.Commit).slice(0, 8)}` : '',
    secret: g.Secret || undefined,
  }));
}

/* ---------- Grype: grype dir:<src> -o json ---------- */
export function parseGrype(data, { src } = {}) {
  return (data?.matches || []).map((m) => {
    const v = m.vulnerability || {};
    const a = m.artifact || {};
    const related = m.relatedVulnerabilities || [];
    const cve = String(v.id || '').startsWith('CVE-') ? v.id : (related.find((r) => String(r.id).startsWith('CVE-'))?.id || v.id);
    const fixV = (v.fix?.versions || [])[0];
    return finding({
      tool: 'grype', category: 'Vulnerability', severity: normSev(v.severity, 'info'),
      title: `${cve} in ${a.name}`,
      file: relPath(a.locations?.[0]?.path, src), pkg: a.name, version: a.version, rule: cve,
      fix: fixV ? `Upgrade ${a.name} to ${fixV}` : '',
      description: v.description || related[0]?.description || '',
      refs: refsOf(v.dataSource, v.urls || [], related[0]?.urls || []),
    });
  });
}

/* ---------- Checkov: checkov -o json (object or array of objects) ---------- */
export function parseCheckov(data, { src } = {}) {
  const blocks = Array.isArray(data) ? data : [data];
  const out = [];
  for (const b of blocks) {
    for (const c of b?.results?.failed_checks || []) {
      const id = String(c.check_id || '');
      out.push(finding({
        tool: 'checkov', category: id.startsWith('CKV_SECRET') ? 'Secret' : 'Misconfiguration',
        severity: normSev(c.severity, 'medium'), title: c.check_name || id,
        file: relPath(c.repo_file_path || c.file_path, src), line: c.file_line_range?.[0], rule: id,
        description: c.resource ? `resource: ${c.resource}` : '', refs: refsOf(c.guideline),
      }));
    }
  }
  return out;
}

/* ---------- OWASP Dependency-Check: --format JSON ---------- */
function purl(id) {
  // pkg:npm/%40scope/name@1.2.3 or pkg:maven/group/artifact@1.0
  const m = /^pkg:[^/]+\/(.+)@([^?#]+)/.exec(String(id || ''));
  if (!m) return null;
  const parts = decodeURIComponent(m[1]).split('/');
  return { name: parts.length > 1 && parts[0].startsWith('@') ? parts.join('/') : parts[parts.length - 1], version: m[2] };
}
export function parseDependencyCheck(data, { src } = {}) {
  const out = [];
  for (const d of data?.dependencies || []) {
    const p = purl(d.packages?.[0]?.id) || { name: d.fileName, version: '' };
    for (const v of d.vulnerabilities || []) {
      const severity = normSev(v.cvssv3?.baseSeverity || v.severity, null) || sevFromScore(v.cvssv3?.baseScore ?? v.cvssv2?.score) || 'medium';
      out.push(finding({
        tool: 'dependency-check', category: 'Vulnerability', severity,
        title: `${v.name} in ${p.name}`, file: relPath(d.filePath, src),
        pkg: p.name, version: p.version, rule: v.name,
        description: v.description, refs: refsOf(v.references || []),
      }));
    }
  }
  return out;
}

/* ---------- SonarQube: api/issues/search + api/hotspots/search ---------- */
const SONAR_LEGACY = { BLOCKER: 'critical', CRITICAL: 'high', MAJOR: 'medium', MINOR: 'low', INFO: 'info' };
const SONAR_IMPACT = { BLOCKER: 'critical', HIGH: 'high', MEDIUM: 'medium', LOW: 'low', INFO: 'info' };
const SONAR_TYPE = { VULNERABILITY: 'Vulnerability', BUG: 'Bug', CODE_SMELL: 'Code smell', SECURITY_HOTSPOT: 'Security hotspot' };
const compFile = (c) => String(c || '').split(':').slice(1).join(':');
export function parseSonar(data, { sonarUrl } = {}) {
  const out = [];
  for (const i of data?.issues || []) {
    const impacts = (i.impacts || []).map((x) => SONAR_IMPACT[x.severity]).filter(Boolean);
    const severity = impacts.length ? impacts.sort((a, b) => ['critical', 'high', 'medium', 'low', 'info'].indexOf(a) - ['critical', 'high', 'medium', 'low', 'info'].indexOf(b))[0]
      : (SONAR_LEGACY[i.severity] || 'medium');
    out.push(finding({
      tool: 'sonarqube', category: SONAR_TYPE[i.type] || 'Code smell', severity,
      title: i.message, file: compFile(i.component), line: i.line ?? i.textRange?.startLine, rule: i.rule,
      refs: sonarUrl && i.key ? [`${sonarUrl}/project/issues?issues=${encodeURIComponent(i.key)}&open=${encodeURIComponent(i.key)}`] : [],
    }));
  }
  for (const h of data?.hotspots || []) {
    out.push(finding({
      tool: 'sonarqube', category: 'Security hotspot', severity: normSev(h.vulnerabilityProbability, 'medium'),
      title: h.message, file: compFile(h.component), line: h.line ?? h.textRange?.startLine, rule: h.ruleKey || h.securityCategory,
      description: h.securityCategory ? `Category: ${h.securityCategory}` : '',
      refs: sonarUrl && h.key ? [`${sonarUrl}/security_hotspots?hotspots=${encodeURIComponent(h.key)}`] : [],
    }));
  }
  return out;
}

/* ---------- SARIF 2.1.0 ---------- */
const KNOWN = ['trivy', 'semgrep', 'gitleaks', 'grype', 'checkov', 'dependency-check', 'sonarqube'];
export function parseSarif(data, { src } = {}) {
  const out = [];
  for (const run of data?.runs || []) {
    const driver = run.tool?.driver || {};
    const dn = String(driver.name || '').toLowerCase();
    const tool = KNOWN.find((k) => dn.includes(k.replace('-', ''))) || KNOWN.find((k) => dn.includes(k)) || 'sarif';
    const rules = new Map((driver.rules || []).map((r) => [r.id, r]));
    for (const r of run.results || []) {
      const rule = rules.get(r.ruleId) || driver.rules?.[r.ruleIndex] || {};
      const props = { ...(rule.properties || {}), ...(r.properties || {}) };
      const tags = [].concat(props.tags || []).map((t) => String(t).toLowerCase());
      const severity = sevFromScore(props['security-severity']) || normSev(r.level || rule.defaultConfiguration?.level, 'medium');
      const loc = r.locations?.[0]?.physicalLocation || {};
      const category = tags.some((t) => t.includes('secret')) ? 'Secret'
        : tags.includes('security') ? 'Vulnerability' : 'Bug';
      out.push(finding({
        tool, category, severity,
        title: (r.message?.text || rule.shortDescription?.text || r.ruleId || '').split('\n')[0],
        file: relPath(loc.artifactLocation?.uri, src), line: loc.region?.startLine, rule: r.ruleId,
        description: rule.fullDescription?.text || r.message?.text, refs: refsOf(rule.helpUri),
      }));
    }
  }
  return out;
}

export const PARSERS = {
  trivy: parseTrivy,
  semgrep: parseSemgrep,
  gitleaks: parseGitleaks,
  grype: parseGrype,
  checkov: parseCheckov,
  'dependency-check': parseDependencyCheck,
  'sonarqube-issues': parseSonar,
  sarif: parseSarif,
};
