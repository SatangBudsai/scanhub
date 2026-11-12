import { test, expect, login } from '../lib/test.js';
import { fakeGitReset, fakeGitState, projectWithRepo, uid, uploadReports, fixture } from '../lib/api.js';
import { fakeGitFromApp, fakeGitHost } from '../lib/env.js';
import { openSealedBox } from '../../server/git/sealedbox.js';

test.describe.serial('One-click CI setup', () => {
  let gh, gl;

  test.beforeAll(async () => {
    await fakeGitReset(fakeGitHost());
  });

  async function connections(admin) {
    gh ||= await admin.post('/api/integrations', { type: 'github', name: uid('Fake GitHub'), baseUrl: `${fakeGitFromApp()}/gh`, token: 'ghp_e2e_fake' });
    gl ||= await admin.post('/api/integrations', { type: 'gitlab', name: uid('Fake GitLab'), baseUrl: `${fakeGitFromApp()}/gl`, token: 'glpat-e2e-fake' });
  }

  test('GitHub: adds the secret and workflow, then opens a Pull Request', async ({ page, step, snap, admin }) => {
    await connections(admin);
    const { repo } = await projectWithRepo(admin);
    const settings = await admin.get('/api/settings');

    await step(page, 'Connect CI page shows the automatic setup card', async () => {
      await page.goto('/#login');
      await login(page);
      await page.goto(`/#connect/${repo.id}`);
      await expect(page.getByRole('heading', { name: 'Set up automatically' })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Or set up manually' })).toBeVisible();
    });
    await step(page, 'Pick the GitHub connection and repo acme/payment-api', async () => {
      await page.locator('#autoConn').selectOption(String(gh.id));
      const item = page.locator('#autoList .picker-item', { hasText: 'acme/payment-api' });
      await expect(item).toBeVisible();
      await item.click();
      await expect(page.locator('#autoPick .picker-sel')).toContainText('acme/payment-api');
      await expect(page.locator('#autoGo')).toBeEnabled();
    });
    await step(page, 'Choose the report-only gate and a Pull Request', async () => {
      await page.locator('.auto-card [data-gmode="report"]').click();
      await expect(page.locator('#toast')).toContainText('CI: Report only');
      await expect(page.locator('.auto-card [data-gmode="report"]')).toHaveAttribute('aria-checked', 'true');
      await expect(page.locator('#autoPick .picker-sel')).toContainText('acme/payment-api');
      await expect(page.locator('[data-amode="pr"]')).toHaveClass(/on/);
    });
    await step(page, 'Turn off Checkov: saved to the repo in ScanHub, not written into the pipeline', async () => {
      await page.locator('#ciTools [data-ct="checkov"]').click();
      await expect(page.locator('#toast')).toContainText('Saved · scanning with');
      await expect(page.locator('#ciTools [data-ct="checkov"]')).toHaveAttribute('aria-pressed', 'false');
      await expect(page.locator('#autoPick .picker-sel')).toContainText('acme/payment-api');
      const r = await admin.get(`/api/repos/${repo.id}`);
      expect(r.tools).not.toContain('checkov');
      expect(r.tools).toContain('trivy');
    });
    await step(page, 'Run automatic setup: every step succeeds', async () => {
      await page.locator('#autoGo').click();
      await expect(page.locator('#toast')).toContainText('Setup complete', { timeout: 60_000 });
      await expect(page.locator('.auto-steps .auto-step')).toHaveCount(5);
      await expect(page.locator('.auto-steps svg.lucide-check')).toHaveCount(5);
      await expect(page.locator('.auto-steps .neg')).toHaveCount(0);
      const pr = page.getByRole('link', { name: 'Open Pull Request' });
      await expect(pr).toHaveAttribute('href', 'https://github.test/acme/payment-api/pull/7');
      await snap(page, 'Pull Request link');
    });
    await step(page, 'GitHub secret decrypts to a working token', async () => {
      const st = await fakeGitState(fakeGitHost());
      const sec = st.gh.secrets.SCANHUB_TOKEN;
      expect(sec.key_id).toBe('kid-1');
      const token = openSealedBox(sec.encrypted_value, st.keys.publicKey, st.keys.secretKey);
      expect(token).toMatch(/^shr_/);
      const r = await uploadReports(token, [{ tool: 'trivy', data: fixture('trivy.json') }]);
      expect(r.status).toBe(200); // report mode: never blocks
      expect(st.gh.variables.SCANHUB_URL).toBe(settings.serverUrl);
    });
    await step(page, 'Workflow on branch scanhub/setup: text/plain, no fail_on', async () => {
      const st = await fakeGitState(fakeGitHost());
      const wf = st.gh.files['scanhub/setup']['.github/workflows/scanhub.yml'].content;
      expect(wf).toContain('/api/v1/scan?');
      expect(wf).toContain('Accept: text/plain');
      expect(wf).toContain('secrets.SCANHUB_TOKEN');
      expect(wf).not.toContain('fail_on');
      expect(wf).not.toContain('tools=trivy');
      expect(wf).toContain('Scanners are chosen in ScanHub. To override here, set SCANHUB_TOOLS=trivy,gitleaks');
      expect(wf).toContain('${SCANHUB_TOOLS:+&tools=$SCANHUB_TOOLS}');
      expect(st.gh.pulls).toHaveLength(1);
      expect(st.gh.pulls[0].head).toBe('scanhub/setup');
    });
    await step(page, 'Repo is linked to the remote with a report-only gate', async () => {
      await page.reload();
      await expect(page.locator('.auto-linked')).toContainText('Linked to acme/payment-api');
      const r = await admin.get(`/api/repos/${repo.id}`);
      expect(r.remote).toMatchObject({ fullName: 'acme/payment-api' });
      expect(r.gate.mode).toBe('report');
    });
  });

  test('GitLab: adds the variable and pipeline file, then opens a Merge Request', async ({ page, step, admin }) => {
    await connections(admin);
    const { repo } = await projectWithRepo(admin);

    await step(page, 'Pick the GitLab connection and repo grp/app', async () => {
      await page.goto('/#login');
      await login(page);
      await page.goto(`/#connect/${repo.id}`);
      await page.locator('#autoConn').selectOption(String(gl.id));
      await expect(page.locator('.auto-card')).toContainText('Repo in GitLab');
      await page.locator('#autoList .picker-item', { hasText: 'grp/app' }).click();
      await expect(page.locator('[data-amode="pr"]')).toContainText('Open Merge Request');
    });
    await step(page, 'Block new Critical + High, then run automatic setup', async () => {
      await expect(page.locator('.auto-card [data-gmode="block"]')).toHaveAttribute('aria-checked', 'true');
      await page.locator('#autoGo').click();
      await expect(page.locator('#toast')).toContainText('Setup complete', { timeout: 60_000 });
      await expect(page.locator('.auto-steps svg.lucide-check')).toHaveCount(5);
      await expect(page.getByRole('link', { name: 'Open Merge Request' })).toHaveAttribute('href', 'https://gitlab.test/grp/app/-/merge_requests/3');
    });
    await step(page, 'GitLab gets a masked variable and an include in the existing .gitlab-ci.yml', async () => {
      const st = await fakeGitState(fakeGitHost());
      expect(st.gl.variables.SCANHUB_TOKEN.masked).toBe(true);
      expect(st.gl.variables.SCANHUB_TOKEN.value).toMatch(/^shr_/);
      expect(st.gl.variables.SCANHUB_URL.value).toBeTruthy();
      const files = st.gl.files['scanhub/setup'];
      const job = files['.gitlab/scanhub.yml'];
      expect(job).toContain('stage: .pre');
      expect(job).toContain('Accept: text/plain');
      expect(job).not.toContain('fail_on');
      const ci = files['.gitlab-ci.yml'];
      expect(ci).toContain('.gitlab/scanhub.yml');
      expect(ci).toContain('build:');
      expect(st.gl.mrs).toHaveLength(1);
      expect(st.gl.mrs[0].source_branch).toBe('scanhub/setup');
    });
    await step(page, 'Set up again without duplicating the include', async () => {
      await page.reload();
      await page.getByRole('button', { name: 'Set up again' }).click();
      await expect(page.locator('#autoGo')).toBeVisible();
      await page.locator('#autoGo').click();
      await expect(page.locator('#toast')).toContainText('Setup complete', { timeout: 60_000 });
      const st = await fakeGitState(fakeGitHost());
      const ci = st.gl.files['scanhub/setup']['.gitlab-ci.yml'];
      expect(ci.split('.gitlab/scanhub.yml').length - 1).toBe(1);
      expect(st.gl.mrs).toHaveLength(1);
    });
  });

  test('Add repo: pick it from the Git connection, no language needed', async ({ page, step, admin }) => {
    await connections(admin);
    const project = await admin.post('/api/projects', { name: uid('Pick') });
    const name = 'payment-api';
    await step(page, 'Add repo opens with the connection repo list', async () => {
      await page.goto('/#login');
      await login(page);
      await page.getByRole('button', { name: `Options for ${project.name}` }).click();
      await page.locator('.pop:not([hidden])').getByRole('button', { name: 'Add repo' }).click();
      const dlg = page.getByRole('dialog', { name: 'Add repo' });
      await expect(dlg.getByLabel('Main language')).toHaveCount(0);
      if (await dlg.locator('#mrConn').count()) await dlg.locator('#mrConn').selectOption(String(gh.id));
      await expect(dlg.locator('#mrQ')).toBeFocused();
      await dlg.locator('#mrQ').fill('payment');
      await expect(dlg.locator('#mrList .picker-item').first()).toContainText('acme/payment-api');
      await expect(dlg.locator('#mrList .picker-item.hi')).toContainText('acme/payment-api');
      await page.keyboard.press('Enter');
      await expect(dlg.getByLabel('Repo name')).toHaveValue(name);
      await expect(dlg.getByLabel('Repo name')).toBeFocused();
      await expect(dlg.getByLabel(/Git URL/)).toHaveValue('https://github.test/acme/payment-api.git');
      await expect(dlg.locator('.picked')).toContainText('acme/payment-api');
      await page.keyboard.press('Enter');
    });
    await step(page, 'Connect CI opens with the picked repo ready for automatic setup', async () => {
      await expect(page).toHaveURL(/#connect\//);
      await expect(page.locator('#autoPick .picker-sel')).toContainText('acme/payment-api');
    });
    await step(page, 'The server saved Git URL and the detected language', async () => {
      const p = (await admin.get('/api/projects')).find((x) => x.id === project.id);
      const repo = await admin.get(`/api/repos/${p.repos[0].id}`);
      expect(repo).toMatchObject({ name, gitUrl: 'https://github.test/acme/payment-api.git', lang: 'Go' });
    });
  });

  test('Add repo: paste a Git URL to fill the name and select the remote', async ({ page, step, admin }) => {
    await connections(admin);
    const project = await admin.post('/api/projects', { name: uid('Paste') });
    // payment-api already exists: the previous test added it
    await step(page, 'Paste a GitHub URL in manual mode', async () => {
      await page.goto('/#login');
      await login(page);
      await page.getByRole('button', { name: `Options for ${project.name}` }).click();
      await page.locator('.pop:not([hidden])').getByRole('button', { name: 'Add repo' }).click();
      const dlg = page.getByRole('dialog', { name: 'Add repo' });
      await dlg.getByRole('button', { name: 'Enter the repo manually instead' }).click();
      await dlg.getByLabel(/Git URL/).fill('git@github.test:acme/website.git');
      await expect(dlg.getByLabel('Repo name')).toHaveValue('website');
      await expect(dlg.locator('#mrGHint')).toContainText('Detected GitHub · acme/website');
      await dlg.getByLabel(/Git URL/).fill('https://github.test/acme/payment-api');
      await expect(dlg.getByLabel('Repo name')).toHaveValue('payment-api');
      await expect(dlg.locator('.picked')).toContainText('acme/payment-api');
    });
    await step(page, 'The name clashes with an existing repo: inline error before submit', async () => {
      const dlg = page.getByRole('dialog', { name: 'Add repo' });
      await expect(dlg.locator('#mrNErr')).toContainText('A repo with this name already exists');
      await dlg.getByLabel('Repo name').fill('payment-api-2');
      await expect(dlg.locator('#mrNErr')).toHaveText('');
      await dlg.getByLabel(/Git URL/).fill('https://github.test/acme/other');
      await expect(dlg.getByLabel('Repo name')).toHaveValue('payment-api-2');
    });
  });

  test('No connection yet: Connect CI links to Settings', async ({ page, step, admin }) => {
    for (const c of [gh, gl].filter(Boolean)) await admin.del(`/api/integrations/${c.id}`);
    const { repo } = await projectWithRepo(admin);
    await step(page, 'Admin sees Add GitHub/GitLab connection', async () => {
      await page.goto('/#login');
      await login(page);
      const left = await admin.get('/api/integrations');
      test.skip(left.length > 0, 'other connections still exist');
      await page.goto(`/#connect/${repo.id}`);
      await expect(page.getByRole('link', { name: 'Add GitHub/GitLab connection' })).toBeVisible();
    });
    await step(page, 'Click it: Settings opens at Git connections', async () => {
      await page.getByRole('link', { name: 'Add GitHub/GitLab connection' }).click();
      await expect(page).toHaveURL(/#settings/);
      await expect(page.locator('#secGit')).toBeInViewport();
    });
  });
});
