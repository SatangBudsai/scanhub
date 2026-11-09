import { test, expect, login } from '../lib/test.js';
import { projectWithRepo, standardReports, uploadReports } from '../lib/api.js';

test.describe('Page hygiene', () => {
  test('No console errors on any page', async ({ page, step, admin }) => {
    const errors = [];
    // The login page asks /api/auth/me and a locked share link asks /api/share/<token>; both answer 401 by design
    // and Chromium logs that network status as a console error. Only those expected 401 probes are ignored.
    const expected401 = (m) => /status of 401/.test(m.text()) && /\/api\/(auth\/me|share\/)/.test(m.location()?.url || '');
    page.on('console', (m) => { if (m.type() === 'error' && !expected401(m)) errors.push(`${page.url()} :: ${m.text()} ${m.location()?.url || ''}`); });
    page.on('pageerror', (e) => errors.push(`${page.url()} :: ${e.message}`));

    const { repo, token } = await projectWithRepo(admin);
    const up = await uploadReports(token, standardReports(), { query: 'gate=report' });
    const share = (await admin.post(`/api/scans/${up.json.scanId}/shares`, { mode: 'password', password: 'console-pass-1', options: {} })).share;

    const visit = async (name, go, ready) => {
      await step(page, name, async () => {
        await go();
        await expect(ready()).toBeVisible();
        await page.waitForLoadState('networkidle');
        expect(errors, errors.join('\n')).toEqual([]);
      });
    };

    await visit('Login page', () => page.goto('/#login'), () => page.getByRole('heading', { name: 'Sign in' }));
    await step(page, 'login', async () => { await login(page); });
    await visit('Projects page', () => page.goto('/#projects'), () => page.getByRole('heading', { name: 'Projects', exact: true }));
    await visit('Repo page and scan results', () => page.goto(`/#repo/${repo.id}`), () => page.locator('.scanbar'));
    await visit('Open a finding', async () => { await page.locator('[data-view="all"]').click(); await page.locator('#fList .f-row').first().click(); }, () => page.locator('.f.open .f-detail'));
    await visit('Report dialog', () => page.getByRole('button', { name: 'Report' }).click(), () => page.getByRole('dialog', { name: 'Report for scan #1' }));
    await visit('Connect CI page', () => page.goto(`/#connect/${repo.id}`), () => page.getByRole('heading', { name: 'Connect CI' }));
    await visit('Settings page', () => page.goto('/#settings'), () => page.getByRole('heading', { name: 'Settings', exact: true }));
    await visit('Users page', () => page.goto('/#users'), () => page.getByRole('heading', { name: 'Users', exact: true }));
    await visit('Groups tab', () => page.goto('/#users/groups'), () => page.getByRole('tab', { name: /Groups/ }));
    await visit('Report page', () => page.goto(`/report.html?scan=${up.json.scanId}`), () => page.locator('main.sheet h1'));
    await visit('Password-protected share link', () => page.goto(new URL(share.url).pathname), () => page.getByRole('heading', { name: 'This report is password-protected' }));
    await visit('Missing page', () => page.goto('/#nope'), () => page.getByRole('heading', { name: 'Page not found' }));
  });
});
