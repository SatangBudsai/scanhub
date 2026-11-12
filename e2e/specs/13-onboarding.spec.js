import { test, expect, login } from '../lib/test.js';
import { apiAs, makeUser, standardReports, uid, uploadReports } from '../lib/api.js';

// A new MAINTAINER sees no projects, so the checklist starts from step 1
test.describe('Getting started checklist', () => {
  test('progresses from real data, can be dismissed and reopened', async ({ page, step, snap, admin }) => {
    const user = await makeUser(admin, { role: 'MAINTAINER', prefix: 'onboard' });
    const card = page.locator('#onboard');
    const stepRow = (k) => card.locator(`[data-obstep="${k}"]`);

    await step(page, 'A first-time user sees Getting started on Projects with nothing done', async () => {
      await page.goto('/#login');
      await login(page, user.username, user.password);
      await expect(card.getByRole('heading', { name: 'Getting started' })).toBeVisible();
      await expect(card).toContainText('0 of 4 steps done');
      for (const k of ['project', 'repo', 'ci', 'results']) await expect(stepRow(k)).toHaveAttribute('data-done', 'false');
      await expect(stepRow('repo').getByRole('button', { name: 'Add a repo' })).toBeDisabled();
      await expect(card.locator('.ob-grp', { hasText: 'Admin setup' })).toHaveCount(0);
      await expect(page.locator('.empty-big .step-tag')).toContainText('Step 1');
      await snap(page, 'Getting started');
    });

    const project = uid('Onboard');
    await step(page, 'Step 1: Create a project from the checklist', async () => {
      await stepRow('project').getByRole('button', { name: 'Create a project' }).click();
      await page.getByLabel('Project name').fill(project);
      await page.getByRole('dialog').getByRole('button', { name: 'Create' }).click();
      await expect(stepRow('project')).toHaveAttribute('data-done', 'true');
      await expect(card).toContainText('1 of 4 steps done');
    });

    const name = uid('onb').toLowerCase();
    await step(page, 'Step 2: Add a repo from the checklist; it opens Connect CI', async () => {
      await stepRow('repo').getByRole('button', { name: 'Add a repo' }).click();
      const dlg = page.getByRole('dialog', { name: 'Add repo' });
      const manual = dlg.getByRole('button', { name: 'Enter the repo manually instead' });
      if (await manual.count()) await manual.click();
      await dlg.getByLabel('Repo name').fill(name);
      await dlg.getByLabel('Repo name').press('Enter');
      await expect(page).toHaveURL(/#connect\//);
      await expect(page.locator('.step-n').first()).toHaveText('1');
    });

    let repoId;
    await step(page, 'Back on Projects, step 3 points at Connect CI for the new repo', async () => {
      await page.goto('/#projects');
      await expect(stepRow('repo')).toHaveAttribute('data-done', 'true');
      await expect(stepRow('ci')).toHaveAttribute('data-done', 'false');
      const href = await stepRow('ci').getByRole('link', { name: 'Connect CI' }).getAttribute('href');
      expect(href).toMatch(/^#connect\/\d+$/);
      repoId = href.split('/')[1];
    });

    await step(page, 'CI sends its first results: steps 3 and 4 are done and the card goes away', async () => {
      const me = await apiAs(user.username, user.password);
      const { token } = await me.post(`/api/repos/${repoId}/token`);
      await me.dispose();
      const r = await uploadReports(token, standardReports());
      expect([200, 422]).toContain(r.status);
      await page.reload();
      await expect(page.locator('.repo-row', { hasText: name })).toBeVisible();
      await expect(card).toHaveCount(0);
    });

    await step(page, 'Reopen it from the account menu: all four steps are done', async () => {
      await page.getByRole('button', { name: `Account of ${user.username}` }).click();
      await page.getByRole('menuitem', { name: 'Getting started' }).click();
      await expect(card).toContainText('All set');
      for (const k of ['project', 'repo', 'ci', 'results']) await expect(stepRow(k)).toHaveAttribute('data-done', 'true');
      await expect(stepRow('results').locator('.ob-acts')).toHaveText('Done');
      await expect(card.locator('[data-obstep="gate"]')).toBeVisible();
    });

    await step(page, 'Close it: it stays closed after a reload', async () => {
      await card.getByRole('button', { name: 'Close' }).click();
      await expect(card).toHaveCount(0);
      await page.reload();
      await expect(page.locator('.repo-row', { hasText: name })).toBeVisible();
      await expect(card).toHaveCount(0);
    });
  });

  test('Admins also get an Admin setup group that links to Settings', async ({ page, step, admin }) => {
    await step(page, 'Reopen Getting started as admin', async () => {
      await page.goto('/#login');
      await login(page);
      await page.getByRole('button', { name: /^Account of / }).click();
      await page.getByRole('menuitem', { name: 'Getting started' }).click();
      const card = page.locator('#onboard');
      await expect(card.locator('.ob-grp', { hasText: 'Admin setup' })).toBeVisible();
      await expect(card.locator('[data-obstep="git"]')).toBeVisible();
      await expect(card.locator('[data-obstep="invite"]')).toHaveAttribute('data-done', 'true');
    });
    await step(page, 'The Git connection step opens Settings at Git connections', async () => {
      const git = page.locator('[data-obstep="git"]');
      if ((await git.getAttribute('data-done')) === 'true') return;
      await git.getByRole('button', { name: 'Add connection' }).click();
      await expect(page).toHaveURL(/#settings/);
      await expect(page.locator('#secGit')).toBeInViewport();
    });
  });
});
