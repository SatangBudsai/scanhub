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
