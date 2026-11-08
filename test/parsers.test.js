import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  parseCheckov, parseDependencyCheck, parseGitleaks, parseGrype, parseSarif, parseSemgrep, parseSonar, parseTrivy,
} from '../server/scan/parsers/index.js';

const fx = (name) => JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'fixtures', name), 'utf8'));

test('trivy: vulnerabilities, secrets and failed misconfigurations only', () => {
  const f = parseTrivy(fx('trivy.json'));
  assert.equal(f.length, 4);
  const crypto = f.find((x) => x.rule === 'CVE-2024-45337');
  assert.equal(crypto.severity, 'critical');
  assert.equal(crypto.category, 'Vulnerability');
  assert.equal(crypto.pkg, 'golang.org/x/crypto');
  assert.equal(crypto.version, 'v0.28.0');
  assert.match(crypto.fix, /0\.31\.0/);
  const secret = f.find((x) => x.category === 'Secret');
  assert.deepEqual([secret.file, secret.line, secret.severity], ['config/dev.yaml', 14, 'critical']);
  const mis = f.find((x) => x.category === 'Misconfiguration');
  assert.equal(mis.rule, 'AVD-DS-0002');
  assert.equal(mis.severity, 'high');
  assert.ok(!f.some((x) => x.rule === 'AVD-DS-0026'), 'passed checks are ignored');
});

test('semgrep: severity, category and secret detection', () => {
  const f = parseSemgrep(fx('semgrep.json'));
  assert.equal(f.length, 3);
  const sqli = f.find((x) => x.file === 'internal/repo/order.go');
  assert.equal(sqli.category, 'Vulnerability');
  assert.equal(sqli.severity, 'critical', 'high confidence + high impact bumps ERROR to critical');
  assert.equal(sqli.line, 88);
  const sec = f.find((x) => x.file === 'config/dev.yaml');
  assert.equal(sec.category, 'Secret');
  assert.equal(sec.severity, 'high');
  const smell = f.find((x) => x.file === 'internal/handler/refund.go');
  assert.equal(smell.category, 'Code smell');
  assert.equal(smell.severity, 'low');
});

test('gitleaks: critical secret, keeps the raw secret only for redaction', () => {
  const [g] = parseGitleaks(fx('gitleaks.json'));
  assert.equal(g.severity, 'critical');
  assert.equal(g.category, 'Secret');
  assert.equal(g.file, 'config/dev.yaml');
  assert.equal(g.secret, 'AKIAZ7Q3EXAMPLE4KEY9');
});

test('grype: prefers the CVE id and strips the source prefix', () => {
  const f = parseGrype(fx('grype.json'), { src: '/data/work/1/src' });
  assert.equal(f.length, 2);
  assert.equal(f[0].rule, 'CVE-2024-45337');
  assert.equal(f[0].file, 'go.mod');
  assert.equal(f[0].severity, 'critical');
  assert.match(f[0].fix, /0\.31\.0/);
  assert.equal(f[1].pkg, 'stdlib');
});

test('checkov: array output, null severity falls back to medium', () => {
  const f = parseCheckov(fx('checkov.json'));
  assert.equal(f.length, 2);
  assert.deepEqual([f[0].rule, f[0].file, f[0].line, f[0].severity], ['CKV_DOCKER_3', 'Dockerfile', 1, 'medium']);
  assert.equal(f[1].severity, 'low');
  // single object form
  assert.equal(parseCheckov(fx('checkov.json')[0]).length, 1);
  // empty summary-only output
  assert.equal(parseCheckov({ passed: 0, failed: 0 }).length, 0);
});

test('dependency-check: purl package names including scoped npm', () => {
  const f = parseDependencyCheck(fx('dependency-check.json'), { src: '/data/work/2/src' });
  assert.equal(f.length, 2);
  assert.deepEqual([f[0].pkg, f[0].version, f[0].severity, f[0].rule], ['lodash', '4.17.4', 'critical', 'CVE-2019-10744']);
  assert.equal(f[1].pkg, '@babel/traverse');
});

test('sonarqube: impacts, legacy severities and hotspots', () => {
  const f = parseSonar(fx('sonarqube.json'), { sonarUrl: 'https://sonar.example' });
  assert.equal(f.length, 4);
  const vuln = f.find((x) => x.category === 'Vulnerability');
  assert.deepEqual([vuln.file, vuln.line, vuln.severity], ['internal/repo/order.go', 88, 'high']);
  assert.equal(f.find((x) => x.category === 'Code smell').severity, 'high', 'legacy CRITICAL maps to high');
  const bug = f.find((x) => x.category === 'Bug');
  assert.deepEqual([bug.line, bug.severity], [57, 'medium']);
  const hs = f.find((x) => x.category === 'Security hotspot');
  assert.equal(hs.severity, 'medium');
  assert.match(hs.refs[0], /sonar\.example\/security_hotspots/);
});

test('sarif: security-severity score and tags', () => {
  const [s] = parseSarif(fx('sarif.json'));
  assert.equal(s.tool, 'sarif');
  assert.equal(s.severity, 'high');
  assert.equal(s.category, 'Vulnerability');
  assert.deepEqual([s.file, s.line], ['src/routes/orders.js', 31]);
});

test('parsers tolerate empty input', () => {
  for (const p of [parseTrivy, parseSemgrep, parseGitleaks, parseGrype, parseCheckov, parseDependencyCheck, parseSonar, parseSarif]) {
    assert.deepEqual(p({}), []);
    assert.deepEqual(p(null), []);
  }
});
