import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import nacl from 'tweetnacl';
import { openSealedBox, sealedBox } from '../server/git/sealedbox.js';
import { mergeGitlabInclude, PR_TITLE, provider, SETUP_BRANCH } from '../server/git/providers.js';
import { startFakeGit } from './helpers/fake-git.js';

let fake;
before(async () => { fake = await startFakeGit(); });
after(async () => { await fake.close(); });

// collects steps like the auto-setup route does
function stepper() {
  const steps = [];
  const step = async (key, fn) => {
    try { steps.push({ key, ok: true, message: await fn() }); } catch (e) { steps.push({ key, ok: false, message: e.message }); throw e; }
  };
  return { steps, step };
}

test('sealed box opens with the recipient keypair (libsodium crypto_box_seal format)', () => {
  const kp = nacl.box.keyPair();
  const pk = Buffer.from(kp.publicKey).toString('base64');
  const sk = Buffer.from(kp.secretKey).toString('base64');
  const c = sealedBox('shr_secret-value', pk);
  const raw = Buffer.from(c, 'base64');
  assert.equal(raw.length, 32 + 16 + 'shr_secret-value'.length, 'ephemeral pk + MAC + message');
  assert.equal(openSealedBox(c, pk, sk), 'shr_secret-value');
  assert.notEqual(sealedBox('shr_secret-value', pk), c, 'a fresh ephemeral key every time');
  const other = nacl.box.keyPair();
  assert.equal(openSealedBox(c, pk, Buffer.from(other.secretKey).toString('base64')), null);
});

test('github: test, repo search', async () => {
  const gh = provider('github', fake.github, 'ghp_test');
  assert.deepEqual(await gh.test(), { ok: true, account: 'octo', scopesOk: true, missing: [] });
  fake.state.ghScopes = 'repo';
  assert.deepEqual((await gh.test()).missing, ['workflow']);
  fake.state.ghScopes = 'repo, workflow';
  const repos = await gh.repos('pay');
  assert.deepEqual(repos, [{ fullName: 'acme/payment-api', defaultBranch: 'main', cloneUrl: 'https://github.test/acme/payment-api.git', webUrl: 'https://github.test/acme/payment-api', private: true }]);
  assert.equal(fake.state.calls.at(-1).auth, 'Bearer ghp_test');
});

test('github: PR flow sets the secret, variable, workflow on scanhub/setup and opens a PR; a rerun updates', async () => {
  const gh = provider('github', fake.github, 'ghp_test');
  const params = { fullName: 'acme/payment-api', mode: 'pr', tools: ['trivy', 'gitleaks'], scanhubToken: 'shr_abc123', scanhubUrl: 'https://scanhub.example' };
  const { steps, step } = stepper();
  const out = await gh.autoSetup(params, step);
  assert.deepEqual(steps.map((s) => [s.key, s.ok]), [['secret', true], ['file', true], ['pr', true]]);
  assert.equal(out.prUrl, 'https://github.test/acme/payment-api/pull/7');
  assert.equal(out.defaultBranch, 'main');

  const secret = fake.state.gh.secrets.SCANHUB_TOKEN;
  assert.equal(secret.key_id, 'kid-1');
  assert.equal(openSealedBox(secret.encrypted_value, fake.state.keys.publicKey, fake.state.keys.secretKey), 'shr_abc123');
  assert.equal(fake.state.gh.variables.SCANHUB_URL, 'https://scanhub.example');

  const wf = fake.state.gh.files[SETUP_BRANCH]['.github/workflows/scanhub.yml'].content;
  assert.match(wf, /\$\{\{ vars\.SCANHUB_URL \}\}/);
  assert.match(wf, /\$\{\{ secrets\.SCANHUB_TOKEN \}\}/);
  assert.match(wf, /wait=1&tools=trivy,gitleaks/);
  assert.ok(wf.includes('-H "Accept: text/plain"'));
  assert.ok(!wf.includes('fail_on'), 'block / report comes from the repo gate');
  assert.match(wf, /rc=\$\?\n\s+cat scanhub-result\.txt[^\n]*\n\s+exit \$rc/, 'prints the summary and keeps the exit code');
  // runs on every branch, tag and PR; ScanHub decides what to scan before any upload
  assert.match(wf, /branches: \['\*\*'\]\n\s+tags: \['\*\*'\]/);
  assert.ok(wf.includes('/api/v1/check?$Q'), 'asks ScanHub first');
  assert.ok(wf.indexOf('/api/v1/check?$Q') < wf.indexOf('/api/v1/scan?$Q'), 'asks before uploading');
  assert.ok(!wf.includes('shr_abc123'), 'the token is never written into the repo');
  const pr = fake.state.gh.pulls[0];
  assert.deepEqual([pr.title, pr.head, pr.base], [PR_TITLE, SETUP_BRANCH, 'main']);
  assert.ok(!fake.state.gh.files.main?.['.github/workflows/scanhub.yml'], 'main is untouched in PR mode');

  // rerun: variable exists (409 -> PATCH), branch exists (422 -> reset), file updated with its sha, PR reused
  const before = fake.state.calls.length;
  const again = stepper();
  const out2 = await gh.autoSetup({ ...params, tools: null }, again.step);
  assert.ok(again.steps.every((s) => s.ok));
  const calls = fake.state.calls.slice(before);
  assert.ok(calls.some((c) => c.method === 'PATCH' && c.path.endsWith('/actions/variables/SCANHUB_URL')));
  assert.ok(calls.some((c) => c.method === 'PATCH' && c.path.endsWith('/git/refs/heads/scanhub/setup') && c.body.force === true));
  assert.ok(calls.find((c) => c.method === 'PUT' && c.path.includes('/contents/')).body.sha);
  assert.ok(!calls.some((c) => c.method === 'POST' && c.path.endsWith('/pulls')), 'no second PR');
  assert.equal(out2.prUrl, 'https://github.test/acme/payment-api/pull/7');
  assert.ok(!fake.state.gh.files[SETUP_BRANCH]['.github/workflows/scanhub.yml'].content.includes('tools='));
});

test('github: commit mode writes to the default branch without a PR', async () => {
  const gh = provider('github', fake.github, 'ghp_test');
  const before = fake.state.calls.length;
  const { steps, step } = stepper();
  const out = await gh.autoSetup({ fullName: 'acme/payment-api', mode: 'commit', tools: null, scanhubToken: 'shr_x', scanhubUrl: 'https://s' }, step);
  assert.ok(steps.every((s) => s.ok));
  assert.equal(out.prUrl, null);
  assert.match(out.commitUrl, /\/commit\//);
  assert.ok(fake.state.gh.files.main['.github/workflows/scanhub.yml']);
  const calls = fake.state.calls.slice(before);
  assert.ok(!calls.some((c) => c.path.includes('/git/refs') || c.path.endsWith('/pulls')));
});

test('github: a failing step stops the rest and is reported', async () => {
  const gh = provider('github', fake.github, 'ghp_test');
  const { steps, step } = stepper();
  await assert.rejects(gh.autoSetup({ fullName: 'acme/unknown', mode: 'pr', scanhubToken: 't', scanhubUrl: 'u' }, step), /404/);
  assert.deepEqual(steps, [], 'repo lookup failed before any step');
});

test('gitlab: test, search, masked variables, job file, include merged once, MR', async () => {
  const gl = provider('gitlab', fake.gitlab, 'glpat_test');
  assert.deepEqual(await gl.test(), { ok: true, account: 'gl-user', scopesOk: true, missing: [] });
  assert.equal((await gl.repos('app'))[0].fullName, 'grp/app');
  assert.equal(fake.state.calls.at(-1).auth, 'glpat_test');

  const params = { fullName: 'grp/app', mode: 'pr', tools: null, scanhubToken: 'shr_glToken_123', scanhubUrl: 'https://scanhub.example' };
  const { steps, step } = stepper();
  const out = await gl.autoSetup(params, step);
  assert.deepEqual(steps.map((s) => [s.key, s.ok]), [['secret', true], ['file', true], ['pr', true]]);
  assert.deepEqual([fake.state.gl.variables.SCANHUB_TOKEN.masked, fake.state.gl.variables.SCANHUB_TOKEN.value], [true, 'shr_glToken_123']);
  assert.equal(fake.state.gl.variables.SCANHUB_URL.masked, false);
  const files = fake.state.gl.files[SETUP_BRANCH];
  assert.match(files['.gitlab/scanhub.yml'], /\$SCANHUB_URL\/api\/v1\/scan\?\$Q&commit=\$CI_COMMIT_SHA&wait=1"/);
  assert.match(files['.gitlab/scanhub.yml'], /elif \[ -n "\$CI_COMMIT_TAG" \]; then KIND=tag/, 'tags are sent as tags');
  assert.ok(files['.gitlab/scanhub.yml'].includes('-H "Accept: text/plain"'));
  assert.match(files['.gitlab/scanhub.yml'], /rc=\$\?\n\s+cat scanhub-result\.txt[^\n]*\n\s+exit \$rc/);
  assert.match(files['.gitlab-ci.yml'], /^include:\n {2}- local: \.gitlab\/scanhub\.yml\n/);
  assert.match(files['.gitlab-ci.yml'], /build:\n {2}stage: build/, 'existing content kept');
  assert.equal(out.prUrl, 'https://gitlab.test/grp/app/-/merge_requests/3');
  assert.deepEqual([fake.state.gl.mrs[0].title, fake.state.gl.mrs[0].target_branch], [PR_TITLE, 'main']);
  assert.ok(!fake.state.gl.files.main['.gitlab/scanhub.yml'], 'main untouched in MR mode');

  // rerun: variables updated, include not added twice, MR reused
  const again = stepper();
  await gl.autoSetup(params, again.step);
  assert.ok(again.steps.every((s) => s.ok));
  const lastCommit = fake.state.gl.commits.at(-1);
  assert.deepEqual(lastCommit.actions.map((a) => [a.action, a.file_path]), [['update', '.gitlab/scanhub.yml']]);
  assert.equal(files['.gitlab-ci.yml'].match(/scanhub\.yml/g).length, 1);
  assert.equal(fake.state.gl.mrs.length, 1);
  assert.ok(fake.callsMatching('PUT', /variables\/SCANHUB_TOKEN$/).length >= 1);

  // commit mode goes to the default branch
  const c = stepper();
  const outC = await gl.autoSetup({ ...params, mode: 'commit' }, c.step);
  assert.equal(outC.prUrl, null);
  assert.match(fake.state.gl.files.main['.gitlab-ci.yml'], /local: \.gitlab\/scanhub\.yml/);
  assert.ok(fake.state.gl.files.main['.gitlab/scanhub.yml']);
});

test('gitlab include merge keeps every existing form', () => {
  const L = '- local: .gitlab/scanhub.yml';
  assert.equal(mergeGitlabInclude(''), `include:\n  ${L}\n`);
  assert.equal(mergeGitlabInclude('stages: [test]\n'), `include:\n  ${L}\n\nstages: [test]\n`);
  assert.equal(mergeGitlabInclude('include:\n  - template: Security/SAST.gitlab-ci.yml\n\njob:\n  script: x\n'),
    `include:\n  - template: Security/SAST.gitlab-ci.yml\n  ${L}\n\njob:\n  script: x\n`);
  assert.equal(mergeGitlabInclude("include: 'ci/base.yml'\njob:\n  script: x\n"), `include:\n  - 'ci/base.yml'\n  ${L}\njob:\n  script: x\n`);
  assert.equal(mergeGitlabInclude('include: [a.yml, b.yml]\n'), `include:\n  - a.yml\n  - b.yml\n  ${L}\n`);
  assert.equal(mergeGitlabInclude('include:\n  project: grp/ci\n  file: base.yml\njob:\n  script: x\n'),
    `include:\n  - project: grp/ci\n    file: base.yml\n  ${L}\njob:\n  script: x\n`);
  assert.equal(mergeGitlabInclude(`include:\n  ${L}\n`), null);
  assert.equal(mergeGitlabInclude("include:\n  - local: '/.gitlab/scanhub.yml'\n"), null);
});
