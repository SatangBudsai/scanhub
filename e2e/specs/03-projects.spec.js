import { test, expect, login } from '../lib/test.js';
import { uid } from '../lib/api.js';

test.describe('Projects and repos', () => {
  test('Create, rename, add a repo, configure it, then delete', async ({ page, step, admin }) => {
    const name = uid('Payment Platform');
    const renamed = `${name} v2`;
    const repoName = uid('payment-api').toLowerCase();
    const group = () => page.locator('section.group', { has: page.getByRole('heading', { name: renamed, exact: true }) });

    await step(page, 'Sign in and click New project', async () => {
      await page.goto('/#login');
      await login(page, undefined, undefined, { expectHash: /#projects/ });
      await page.locator('#newProj').click();
      await expect(page.getByRole('dialog', { name: 'New project' })).toBeVisible();
    });
    await step(page, 'A too-short name is rejected', async () => {
      await page.getByRole('textbox', { name: 'Project name' }).fill('a');
      await page.getByRole('button', { name: 'Create', exact: true }).click();
      await expect(page.locator('#mErr')).toHaveText('Name must be at least 2 characters');
    });
    await step(page, 'Name it and create the project', async () => {
      await page.getByRole('textbox', { name: 'Project name' }).fill(name);
      await page.getByRole('button', { name: 'Create', exact: true }).click();
      await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
    });
    await step(page, 'Rename the project from the ⋯ menu', async () => {
      await page.getByRole('button', { name: `Options for ${name}` }).click();
      await page.locator('.pop:not([hidden])').getByRole('button', { name: 'Rename project' }).click();
      await page.getByRole('textbox', { name: 'Project name' }).fill(renamed);
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(page.getByRole('heading', { name: renamed, exact: true })).toBeVisible();
    });
    await step(page, 'Add a repo from the project menu', async () => {
      await page.getByRole('button', { name: `Options for ${renamed}` }).click();
      await page.locator('.pop:not([hidden])').getByRole('button', { name: 'Add repo' }).click();
      const dlg = page.getByRole('dialog', { name: 'Add repo' });
      await expect(dlg.getByLabel('Project')).toHaveValue(/\d+/);
      await dlg.getByLabel('Repo name').fill('Bad Name');
      await dlg.getByRole('button', { name: 'Add and connect' }).click();
      await expect(dlg.locator('#mErr')).toContainText('Repo name may only use');
      await dlg.getByLabel('Repo name').fill(repoName);
      await dlg.getByLabel('Main language').selectOption('Go');
      await dlg.getByRole('button', { name: 'Add and connect' }).click();
    });
    await step(page, 'Connect CI opens with a token shown once', async () => {
      await expect(page).toHaveURL(/#connect\//);
      await expect(page.getByRole('heading', { name: 'Connect CI' })).toBeVisible();
      await expect(page.locator('#tokVal')).toHaveValue(/^shr_/);
      await expect(page.getByText('Copy it now. It is shown only once', { exact: false })).toBeVisible();
    });
    await step(page, 'The repo page has no scan results yet', async () => {
      await page.locator('.crumb').getByRole('link', { name: repoName }).click();
      await expect(page.getByRole('heading', { name: 'No scan results yet' })).toBeVisible();
    });
    await step(page, 'Repo settings: a daily scan without a Git URL is rejected', async () => {
      await page.getByRole('button', { name: 'More options' }).click();
      await page.getByRole('button', { name: 'Repo settings' }).click();
      const dlg = page.getByRole('dialog', { name: 'Repo settings' });
      await dlg.getByLabel('Automatic scan').selectOption('daily');
      await dlg.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(dlg.locator('#mErr')).toHaveText('Daily automatic scans need a Git URL');
    });
    await step(page, 'Set branch, Git URL, daily scan and pick scanners', async () => {
      const dlg = page.getByRole('dialog', { name: 'Repo settings' });
      await dlg.getByLabel('Main branch').fill('develop');
      await dlg.getByLabel(/Git URL/).fill('https://gitlab.example.com/pay/payment-api.git');
      await dlg.getByRole('button', { name: 'Choose' }).click();
      await dlg.locator('[data-rt="checkov"]').click();
      await expect(dlg.locator('[data-rt="checkov"]')).toHaveAttribute('aria-pressed', 'false');
      await dlg.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(dlg).toBeHidden();
      await expect(page.locator('.head .meta')).toContainText('develop');
    });
    await step(page, 'The server saved every repo setting', async () => {
      const p = (await admin.get('/api/projects')).find((x) => x.name === renamed);
      const repo = await admin.get(`/api/repos/${p.repos[0].id}`);
      expect(repo).toMatchObject({ name: repoName, branch: 'develop', gitUrl: 'https://gitlab.example.com/pay/payment-api.git', schedule: 'daily' });
      expect(repo.tools).not.toContain('checkov');
      expect(repo.tools).toContain('trivy');
    });
    await step(page, 'A project with repos cannot be deleted', async () => {
      await page.getByRole('link', { name: 'Projects', exact: true }).click();
      await page.getByRole('button', { name: `Options for ${renamed}` }).click();
      await page.locator('.pop:not([hidden])').getByRole('button', { name: 'Delete project' }).click();
      await expect(page.locator('#toast')).toContainText('Only empty projects can be deleted');
    });
    await step(page, 'Delete the repo from Repo settings (click twice)', async () => {
      await group().getByRole('link', { name: new RegExp(repoName) }).click();
      await page.getByRole('button', { name: 'More options' }).click();
      await page.getByRole('button', { name: 'Repo settings' }).click();
      const del = page.locator('#rsDel');
      await del.click();
      await expect(del).toContainText('Click again to delete');
      await del.click();
      await expect(page).toHaveURL(/#projects/);
      await expect(group().getByText('No repos yet')).toBeVisible();
    });
    await step(page, 'Delete the now-empty project', async () => {
      await page.getByRole('button', { name: `Options for ${renamed}` }).click();
      await page.locator('.pop:not([hidden])').getByRole('button', { name: 'Delete project' }).click();
      await page.getByRole('dialog', { name: 'Delete project' }).getByRole('button', { name: 'Delete project' }).click();
      await expect(page.getByRole('heading', { name: renamed, exact: true })).toHaveCount(0);
    });
  });
});
