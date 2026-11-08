import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseGitleaks, parseGrype, parseSemgrep, parseSonar, parseTrivy } from '../server/scan/parsers/index.js';
import { diffFindings, mergeFindings, summarize } from '../server/scan/merge.js';

const fx = (name) => JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'fixtures', name), 'utf8'));

function sampleSrc() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scanhub-src-'));
  fs.mkdirSync(path.join(dir, 'config'));
  const yaml = Array.from({ length: 20 }, (_, i) => `line${i + 1}: value`);
  yaml[13] = '  access_key: AKIAZ7Q3EXAMPLE4KEY9';
  fs.writeFileSync(path.join(dir, 'config', 'dev.yaml'), yaml.join('\n'));
  return dir;
}

test('merge dedupes the same issue across tools and keeps every tool and rule', () => {
  const raw = [
    ...parseTrivy(fx('trivy.json')),
    ...parseGitleaks(fx('gitleaks.json')),
    ...parseSemgrep(fx('semgrep.json')),
    ...parseGrype(fx('grype.json'), { src: '/data/work/1/src' }),
    ...parseSonar(fx('sonarqube.json')),
  ];
  const m = mergeFindings(raw);
  const secret = m.filter((f) => f.category === 'Secret');
  assert.equal(secret.length, 1, 'trivy + gitleaks + semgrep secret on the same line merge');
  assert.deepEqual(secret[0].tools.sort(), ['gitleaks', 'semgrep', 'trivy']);
  assert.equal(secret[0].severity, 'critical');
  assert.equal(secret[0].rules.length, 3);

  const crypto = m.filter((f) => f.pkg === 'golang.org/x/crypto');
  assert.equal(crypto.length, 1, 'trivy + grype CVE merge');
  assert.deepEqual(crypto[0].tools.sort(), ['grype', 'trivy']);
  assert.equal(crypto[0].location, 'golang.org/x/crypto@v0.28.0');

  const sqli = m.filter((f) => f.file === 'internal/repo/order.go');
  assert.equal(sqli.length, 1, 'semgrep + sonarqube SQL injection merge');
  assert.equal(sqli[0].severity, 'critical');
  assert.equal(sqli[0].location, 'internal/repo/order.go:88');

  // sorted by severity
  const ranks = m.map((f) => ['critical', 'high', 'medium', 'low', 'info'].indexOf(f.severity));
  assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b));
});

test('snippets come from the source and secrets are redacted', () => {
  const src = sampleSrc();
  const m = mergeFindings([...parseGitleaks(fx('gitleaks.json')), ...parseTrivy(fx('trivy.json'))], { src });
  const s = m.find((f) => f.category === 'Secret');
  assert.equal(s.snippet.hl, 14);
  assert.equal(s.snippet.start, 11);
  assert.equal(s.snippet.lines.length, 7);
  const text = JSON.stringify(m);
  assert.ok(!text.includes('AKIAZ7Q3EXAMPLE4KEY9'), 'raw secret never appears');
  assert.ok(s.snippet.lines.some((l) => l.includes('AKIA****')));
  fs.rmSync(src, { recursive: true, force: true });
});

test('a neighbour snippet does not leak a secret, and flagged lines without a known value are masked', () => {
  const src = sampleSrc();
  const p = path.join(src, 'config', 'dev.yaml');
  const lines = fs.readFileSync(p, 'utf8').split('\n');
  lines[14] = '  db_password: "hunter2-very-secret"';
  fs.writeFileSync(p, lines.join('\n'));
  const raw = [
    ...parseGitleaks(fx('gitleaks.json')),
    // a checkov secret on the next line, with no secret value in its report
    { tool: 'checkov', severity: 'medium', category: 'Secret', title: 'Base64 High Entropy String', file: 'config/dev.yaml', line: 15, pkg: '', version: '', rule: 'CKV_SECRET_6', fix: '', description: '', refs: [] },
    // an unrelated finding whose snippet also shows lines 14 and 15
    { tool: 'semgrep', severity: 'low', category: 'Code smell', title: 'x', file: 'config/dev.yaml', line: 13, pkg: '', version: '', rule: 'r', fix: '', description: '', refs: [] },
  ];
  const text = JSON.stringify(mergeFindings(raw, { src }));
  assert.ok(!text.includes('AKIAZ7Q3EXAMPLE4KEY9'));
  assert.ok(!text.includes('hunter2-very-secret'));
  assert.ok(text.includes('hunt****'));
  fs.rmSync(src, { recursive: true, force: true });
});

test('fingerprint follows the line text when code moves', () => {
  const src1 = sampleSrc();
  const a = mergeFindings(parseGitleaks(fx('gitleaks.json')), { src: src1 });
  // same secret moved two lines down
  const src2 = sampleSrc();
  const lines = fs.readFileSync(path.join(src2, 'config', 'dev.yaml'), 'utf8').split('\n');
  lines.splice(0, 0, '# header', '# more');
  fs.writeFileSync(path.join(src2, 'config', 'dev.yaml'), lines.join('\n'));
  const moved = fx('gitleaks.json');
  moved[0].StartLine = 16;
  const b = mergeFindings(parseGitleaks(moved), { src: src2 });
  assert.equal(a[0].fingerprint, b[0].fingerprint);
  [src1, src2].forEach((d) => fs.rmSync(d, { recursive: true, force: true }));
});

test('diff marks new, existing and fixed', () => {
  const first = diffFindings(mergeFindings(parseTrivy(fx('trivy.json'))), null, 1);
  assert.ok(first.every((f) => f.status === 'new' && f.firstSeenNum === 1));

  const t2 = fx('trivy.json');
  t2.Results[0].Vulnerabilities = t2.Results[0].Vulnerabilities.filter((v) => v.VulnerabilityID !== 'CVE-2023-44487');
  t2.Results[0].Vulnerabilities.push({ VulnerabilityID: 'CVE-2024-45338', PkgName: 'golang.org/x/net', InstalledVersion: 'v0.15.0', Severity: 'HIGH', Title: 'x/net/html quadratic parsing' });
  const second = diffFindings(mergeFindings(parseTrivy(t2)), first, 2);
  const by = (s) => second.filter((f) => f.status === s);
  assert.equal(by('new').length, 1);
  assert.equal(by('new')[0].pkg, 'golang.org/x/net');
  assert.equal(by('fixed').length, 1);
  assert.equal(by('fixed')[0].rules[0].id, 'CVE-2023-44487');
  assert.equal(by('existing').length, 3);
  assert.ok(by('existing').every((f) => f.firstSeenNum === 1));

  const sum = summarize(second);
  assert.equal(sum.openCount, 4);
  assert.equal(sum.newCount, 1);
  assert.equal(sum.fixedCount, 1);
  assert.equal(sum.newBySeverity.high, 1);
  assert.deepEqual(sum.counts, [2, 2, 0, 0, 0]);
});
