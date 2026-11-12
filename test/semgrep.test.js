// Semgrep rules source: validation and env precedence (pure functions, no server)
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.SEMGREP_RULES = '';
process.env.SEMGREP_RULES_LICENSE_ACCEPTED = '';
const { config } = await import('../server/config.js');
const { semgrepFrom, semgrepWrites, isSemgrepRegistryId, SEMGREP_SKIP_NOTE } = await import('../server/settings.js');

const withEnv = (rules, accepted, fn) => {
  const saved = { r: config.semgrepRules, a: config.semgrepLicenseAccepted, f: config.semgrepFromEnv };
  Object.assign(config, { semgrepRules: rules, semgrepLicenseAccepted: accepted, semgrepFromEnv: !!rules });
  try { fn(); } finally { Object.assign(config, { semgrepRules: saved.r, semgrepLicenseAccepted: saved.a, semgrepFromEnv: saved.f }); }
};
const LIC = { by: 'admin', at: '2026-01-01T00:00:00.000Z' };

test('registry ids', () => {
  for (const v of ['p/default', 'r/python.lang.security', 'auto', ' p/ci ']) assert.equal(isSemgrepRegistryId(v), true, v);
  for (const v of ['/data/rules.yml', 'https://example.com/rules.yml', 'rules/', '', null]) assert.equal(isSemgrepRegistryId(v), false, String(v));
});

test('nothing chosen: no rules, skip note; never accepted on anyone\'s behalf', () => {
  const s = semgrepFrom({});
  assert.deepEqual([s.mode, s.rules, s.note, s.licenseAccepted, s.fromEnv], [null, null, SEMGREP_SKIP_NOTE, false, false]);
  // an install upgraded from a version that ran p/default silently has no semgrep keys at all
  assert.equal(semgrepFrom({ setupDone: true, schedule: {} }).rules, null);
  // registry mode stored but license withdrawn: skipped
  assert.equal(semgrepFrom({ semgrepRulesMode: 'registry', semgrepLicense: null }).rules, null);
});

test('stored settings: registry with license, custom path, custom registry id', () => {
  assert.equal(semgrepFrom({ semgrepRulesMode: 'registry', semgrepLicense: LIC }).rules, 'p/default');
  const c = semgrepFrom({ semgrepRulesMode: 'custom', semgrepCustomRules: ' /data/rules.yml ' });
  assert.equal(c.rules, '/data/rules.yml');
  assert.equal(c.note, null);
  assert.equal(semgrepFrom({ semgrepRulesMode: 'custom', semgrepCustomRules: 'p/ci' }).rules, null);
  assert.equal(semgrepFrom({ semgrepRulesMode: 'custom', semgrepCustomRules: 'p/ci', semgrepLicense: LIC }).rules, 'p/ci');
  const r = semgrepFrom({ semgrepRulesMode: 'registry', semgrepLicense: LIC });
  assert.deepEqual([r.acceptedBy, r.acceptedAt], ['admin', LIC.at]);
});

test('validation: registry needs the license, custom needs a value', () => {
  const none = semgrepFrom({});
  assert.throws(() => semgrepWrites({ mode: 'registry' }, none, 'admin'), /Accept the Semgrep Rules License/);
  assert.throws(() => semgrepWrites({ mode: 'registry', acceptLicense: false }, none, 'admin'), /Accept/);
  assert.throws(() => semgrepWrites({ mode: 'custom', custom: '  ' }, none, 'admin'), /Enter the custom rules/);
  assert.throws(() => semgrepWrites({ mode: 'custom', custom: 'p/ci' }, none, 'admin'), /Semgrep Rules License/);
  assert.throws(() => semgrepWrites({ mode: 'nope' }, none, 'admin'), /registry or custom/);
  assert.throws(() => semgrepWrites(null, none, 'admin'), /Invalid/);

  const w = Object.fromEntries(semgrepWrites({ mode: 'registry', acceptLicense: true }, none, 'alice'));
  assert.equal(w.semgrepRulesMode, 'registry');
  assert.equal(w.semgrepLicense.by, 'alice');
  assert.ok(!Number.isNaN(Date.parse(w.semgrepLicense.at)));
  // already accepted: keeps the original who / when
  const acc = semgrepFrom({ semgrepLicense: LIC });
  assert.equal(Object.fromEntries(semgrepWrites({ mode: 'registry', acceptLicense: true }, acc, 'bob')).semgrepLicense, undefined);
  assert.deepEqual(semgrepWrites({ mode: 'custom', custom: ' https://example.com/r.yml ' }, none, 'admin'),
    [['semgrepRulesMode', 'custom'], ['semgrepCustomRules', 'https://example.com/r.yml']]);
  // withdraw the license
  assert.deepEqual(semgrepWrites({ mode: null, acceptLicense: false }, acc, 'admin'), [['semgrepLicense', null], ['semgrepRulesMode', null]]);
});

test('env wins over stored settings; registry ids from env need SEMGREP_RULES_LICENSE_ACCEPTED', () => {
  const stored = { semgrepRulesMode: 'custom', semgrepCustomRules: '/data/rules.yml' };
  withEnv('p/default', false, () => {
    const s = semgrepFrom(stored);
    assert.deepEqual([s.fromEnv, s.mode, s.rules, s.envRules], [true, 'registry', null, 'p/default']);
    assert.match(s.note, /SEMGREP_RULES_LICENSE_ACCEPTED=true/);
  });
  withEnv('auto', true, () => assert.equal(semgrepFrom(stored).rules, 'auto'));
  withEnv('p/default', true, () => {
    const s = semgrepFrom({});
    assert.deepEqual([s.rules, s.licenseAccepted, s.note], ['p/default', true, null]);
  });
  withEnv('https://example.com/rules.yml', false, () => {
    const s = semgrepFrom({ semgrepRulesMode: 'registry', semgrepLicense: LIC });
    assert.deepEqual([s.mode, s.rules], ['custom', 'https://example.com/rules.yml']);
  });
});
