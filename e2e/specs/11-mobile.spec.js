import { test, expect, login } from '../lib/test.js';
import { adminApi, ensureSetup, projectWithRepo, standardReports, uploadReports } from '../lib/api.js';

const noOverflow = async (page) => {
  const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
  expect(m.sw, `page is ${m.sw}px wide in a ${m.cw}px viewport`).toBeLessThanOrEqual(m.cw);
};

test.describe('Mobile 390px', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  let repo, scanId;

  test.beforeAll(async () => {
    const api = await adminApi();
    await ensureSetup(api);
    const x = await projectWithRepo(api);
    repo = x.repo;
    const up = await uploadReports(x.token, standardReports(), { query: 'gate=report' });
    scanId = up.json.scanId;
    await api.dispose();
  });

  test('Every page works on a phone with no horizontal scroll', async ({ page, step }) => {
    await step(page, 'Login page', async () => {
      await page.goto('/#login');
      await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
      await noOverflow(page);
    });
    await step(page, 'Projects: nav collapses into one menu button', async () => {
      await login(page);
      await expect(page.getByRole('link', { name: 'Settings', exact: true })).toBeHidden();
      await page.getByRole('button', { name: 'Menu' }).click();
      const nav = page.locator('#navPop');
      await expect(nav).toBeVisible();
      await expect(nav.getByRole('link', { name: repo.name })).toBeVisible();
      await noOverflow(page);
    });
    await step(page, 'Pick a repo from the menu: scan results', async () => {
      await page.locator('#navPop').getByRole('link', { name: repo.name }).click();
      await expect(page.locator('.scanbar .ttl')).toHaveText('Scan #1');
      await noOverflow(page);
    });
    await step(page, 'Findings list and details', async () => {
      await page.locator('[data-view="all"]').click();
      const first = page.locator('#fList .f-row').first();
      await first.scrollIntoViewIfNeeded();
      await first.click();
      await expect(page.locator('.f.open .f-detail')).toBeVisible();
      await noOverflow(page);
    });
    await step(page, 'Connect CI page', async () => {
      await page.goto(`/#connect/${repo.id}`);
      await expect(page.getByRole('heading', { name: 'Connect CI' })).toBeVisible();
      await noOverflow(page);
    });
    await step(page, 'Users page shows cards', async () => {
      await page.goto('/#users');
      await expect(page.getByRole('heading', { name: 'Users', exact: true })).toBeVisible();
      const tr = page.locator('.users-table tbody tr').first();
      const display = await tr.evaluate((el) => getComputedStyle(el).display);
      expect(display).not.toBe('table-row');
      await noOverflow(page);
    });
    await step(page, 'Settings page', async () => {
      await page.goto('/#settings');
      await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
      await noOverflow(page);
    });
    await step(page, 'Client report', async () => {
      await page.goto(`/report.html?scan=${scanId}`);
      await expect(page.locator('main.sheet h1')).toBeVisible();
      await noOverflow(page);
    });
  });
});
