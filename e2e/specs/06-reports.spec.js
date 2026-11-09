import fs from 'node:fs';
import { test, expect, login, newUserPage } from '../lib/test.js';
import { adminApi, ensureSetup, makeUser, projectWithRepo, sql, standardReports, uploadReports } from '../lib/api.js';
import { LOOK, ownsContainer } from '../lib/env.js';
import { pdfInfo } from '../lib/pdf.js';

test.describe.serial('Reports and share links', () => {
  let project, repo, scanId, title;

  test.beforeAll(async () => {
    const api = await adminApi();
    await ensureSetup(api);
    ({ project, repo } = await projectWithRepo(api).then(async (x) => {
      const up = await uploadReports(x.token, standardReports(), { query: 'gate=report' });
      expect(up.status).toBe(200);
      scanId = up.json.scanId;
      return x;
    }));
    title = `Security report: ${repo.name}`;
    await api.dispose();
  });

  // open the report modal on the repo page
  async function openReportModal(page) {
    await page.goto(`/#repo/${repo.id}`);
    await page.getByRole('button', { name: 'Report', exact: true }).click();
    return page.getByRole('dialog', { name: 'Report for scan #1' });
  }

  test('Export a client report as PDF and HTML', async ({ page, step, snap, context }) => {
    let report;
    await step(page, 'Open the report dialog from the repo page', async () => {
      await page.goto('/#login');
      await login(page);
      const dlg = await openReportModal(page);
      await expect(dlg.getByLabel('Report title')).toHaveValue(title);
    });
    await step(page, 'Enter the client name and include High and above only', async () => {
      const dlg = page.getByRole('dialog', { name: 'Report for scan #1' });
      await dlg.getByLabel('Prepared for (client)').fill('Test Company Ltd.');
      await dlg.getByLabel('Severities to include').selectOption('high');
    });
    await step(page, 'Open the report in a new tab', async () => {
      const popup = context.waitForEvent('page');
      await page.getByRole('button', { name: 'Open report' }).click();
      report = await popup;
      await report.waitForLoadState();
      await expect(report.getByRole('heading', { name: title, level: 1 })).toBeVisible();
    });
    await step(report, 'Report shows the client, summary, scanners and only Critical/High', async () => {
      await expect(report.locator('.prepared')).toHaveText('Prepared for Test Company Ltd.');
      await expect(report.getByRole('heading', { name: 'Summary' })).toBeVisible();
      await expect(report.getByRole('heading', { name: 'Scanners used' })).toBeVisible();
      const groups = await report.locator('.sev-h h2').allTextContents();
      expect(groups.length).toBeGreaterThan(0);
      for (const g of groups) expect(['Critical', 'High']).toContain(g.trim());
      await expect(report.locator('.metagrid')).toContainText(repo.name);
    });
    await step(report, 'Print view hides the toolbar', async () => {
      await report.emulateMedia({ media: 'print' });
      await expect(report.locator('#toolbar')).toBeHidden();
      await expect(report.getByRole('heading', { name: title, level: 1 })).toBeVisible();
      await snap(report, 'Print view');
      await report.emulateMedia({ media: 'screen' });
    });
    await step(report, 'Generate an A4 PDF with pages and a title', async () => {
      const pdf = await report.pdf({ format: 'A4', printBackground: true, preferCSSPageSize: true });
      const info = pdfInfo(pdf);
      expect(info.isPdf).toBe(true);
      expect(info.pages).toBeGreaterThan(0);
      expect(info.bytes).toBeGreaterThan(10_000);
      expect(info.title || '').toContain(repo.name);
    });
    await step(report, 'Download HTML: a file with no scripts', async () => {
      const dl = report.waitForEvent('download');
      await report.getByRole('button', { name: 'Download HTML' }).click();
      const d = await dl;
      expect(d.suggestedFilename()).toBe(`scanhub-${repo.name}-scan-1.html`);
      const html = fs.readFileSync(await d.path(), 'utf8');
      expect(html.startsWith('<!doctype html>')).toBe(true);
      expect(html).toContain('Test Company Ltd.');
      expect(html).not.toMatch(/<script/i);
      expect(html).not.toContain('id="toolbar"');
    });
  });

  test('Signed-in-only share link: needs sign-in and project access', async ({ page, step, browser, admin }) => {
    let url;
    const outsider = await makeUser(admin, { role: 'ANALYST', prefix: 'outsider' });
    const member = await makeUser(admin, { role: 'ANALYST', prefix: 'member', projectIds: [project.id] });

    await step(page, 'Create a signed-in-users-only link from the report dialog', async () => {
      await page.goto('/#login');
      await login(page);
      const dlg = await openReportModal(page);
      await dlg.getByRole('button', { name: 'Share link' }).click();
      await dlg.getByRole('button', { name: 'Signed-in users only' }).click();
      await dlg.getByLabel('Expires').selectOption('7');
      await dlg.getByRole('button', { name: 'Create link' }).click();
      await expect(dlg.locator('#shUrl')).toHaveValue(/\/s\/shs_/);
      url = new URL(await dlg.locator('#shUrl').inputValue()).pathname;
      await expect(dlg.locator('.share-row').first()).toContainText('Signed-in users only');
    });
    await step(page, 'A signed-out visitor is asked to sign in', async () => {
      const ctx = await browser.newContext({ ...LOOK, baseURL: new URL(page.url()).origin });
      const p = await ctx.newPage();
      await p.goto(url);
      await expect(p.getByRole('heading', { name: 'Sign-in required' })).toBeVisible();
      await ctx.close();
    });
    let other;
    await step(page, 'A user without project access is refused', async () => {
      other = await newUserPage(browser, outsider);
      await other.page.goto(url);
      await expect(other.page.getByRole('heading', { name: 'This account cannot view this project' })).toBeVisible();
    });
    await step(other.page, 'What the user without access sees', async () => { await other.ctx.close(); });
    let mem;
    await step(page, 'A project member can open the report', async () => {
      mem = await newUserPage(browser, member);
      await mem.page.goto(url);
      await expect(mem.page.getByRole('heading', { name: title, level: 1 })).toBeVisible();
    });
    await step(mem.page, 'What the project member sees', async () => { await mem.ctx.close(); });
  });

  test('Password link: wrong, right, then locked after 5 wrong tries', async ({ page, step, browser }) => {
    let url;
    const pw = 'customer-pass-2026';
    await step(page, 'Create a password-protected link', async () => {
      await page.goto('/#login');
      await login(page);
      const dlg = await openReportModal(page);
      await dlg.getByRole('button', { name: 'Share link' }).click();
      await dlg.getByRole('button', { name: 'Password', exact: true }).click();
      await dlg.getByRole('button', { name: 'Create link' }).click();
      await expect(dlg.locator('#mErr')).toHaveText('Password must be at least 8 characters');
      await dlg.getByLabel('Password', { exact: true }).fill(pw);
      await dlg.getByLabel('Prepared for (client)').fill('ACME Client');
      await dlg.getByRole('button', { name: 'Create link' }).click();
      await expect(dlg.locator('#shUrl')).toHaveValue(/\/s\/shs_/);
      url = new URL(await dlg.locator('#shUrl').inputValue()).pathname;
    });
    const origin = new URL(page.url()).origin;
    const ctx = await browser.newContext({ ...LOOK, baseURL: origin });
    const cust = await ctx.newPage();
    await step(cust, 'The client opens the link and sees the password prompt', async () => {
      await cust.goto(url);
      await expect(cust.getByRole('heading', { name: 'This report is password-protected' })).toBeVisible();
    });
    await step(cust, 'Enter a wrong password', async () => {
      await cust.getByLabel('Password').fill('wrong-pass-0');
      await cust.getByRole('button', { name: 'Open report' }).click();
      await expect(cust.locator('#pwe')).toHaveText('Incorrect password');
    });
    await step(cust, 'Enter the right password: the report opens', async () => {
      await cust.getByLabel('Password').fill(pw);
      await cust.getByRole('button', { name: 'Open report' }).click();
      await expect(cust.getByRole('heading', { name: title, level: 1 })).toBeVisible();
      await expect(cust.locator('.prepared')).toHaveText('Prepared for ACME Client');
    });
    await step(cust, 'Reloading needs no password (already unlocked)', async () => {
      await cust.reload();
      await expect(cust.getByRole('heading', { name: title, level: 1 })).toBeVisible();
    });
    await ctx.close();
    const ctx2 = await browser.newContext({ ...LOOK, baseURL: origin });
    const atk = await ctx2.newPage();
    await step(atk, 'Another browser tries 5 wrong passwords', async () => {
      await atk.goto(url);
      for (let i = 1; i <= 5; i++) {
        await atk.getByLabel('Password').fill(`guess-pass-${i}`);
        await atk.getByRole('button', { name: 'Open report' }).click();
        await expect(atk.locator('#pwe')).toHaveText('Incorrect password');
        await expect(atk.getByRole('button', { name: 'Open report' })).toBeEnabled();
      }
    });
    await step(atk, 'The 6th try is locked out, even with the right password', async () => {
      await atk.getByLabel('Password').fill(pw);
      await atk.getByRole('button', { name: 'Open report' }).click();
      await expect(atk.locator('#pwe')).toHaveText('Too many wrong attempts. Wait 15 minutes and try again');
    });
    await ctx2.close();
  });

  test('Revoked and expired links stop working; views are counted', async ({ page, step, browser, admin }) => {
    const a = (await admin.post(`/api/scans/${scanId}/shares`, { mode: 'password', password: 'pass-for-revoke', options: {} })).share;
    const b = (await admin.post(`/api/scans/${scanId}/shares`, { mode: 'password', password: 'pass-for-expire', expiresInDays: 1, options: {} })).share;
    const pathA = new URL(a.url).pathname, pathB = new URL(b.url).pathname;

    await step(page, 'Share links listed in the report dialog', async () => {
      await page.goto('/#login');
      await login(page);
      const dlg = await openReportModal(page);
      await dlg.getByRole('button', { name: 'Share link' }).click();
      await expect(dlg.locator('.share-row').first()).toBeVisible();
    });
    await step(page, 'Revoke a link (click twice to confirm)', async () => {
      const dlg = page.getByRole('dialog', { name: 'Report for scan #1' });
      const btn = dlg.locator(`[data-revoke="${a.id}"]`);
      await btn.click();
      await expect(btn).toContainText('Click again to revoke');
      await btn.click();
      await expect(page.locator('#toast')).toContainText('Link revoked');
      await expect(dlg.locator(`[data-revoke="${a.id}"]`)).toHaveCount(0);
    });
    await step(page, 'Open the revoked link: Link not found (404)', async () => {
      await page.goto(pathA);
      await expect(page.getByRole('heading', { name: 'Link not found' })).toBeVisible();
      expect((await page.request.get(`/api/share/${pathA.split('/').pop()}`)).status()).toBe(404);
    });
    await step(page, 'Open an expired link: Link expired (410)', async () => {
      test.skip(!ownsContainer(), 'needs to move the expiry in the database of a container the suite started itself');
      sql(`UPDATE shares SET expires_at = now() - interval '1 hour' WHERE id = ${Number(b.id)}`);
      await page.goto(pathB);
      await expect(page.getByRole('heading', { name: 'Link expired' })).toBeVisible();
      expect((await page.request.get(`/api/share/${pathB.split('/').pop()}`)).status()).toBe(410);
    });
    await step(page, 'Views are counted', async () => {
      const shares = await admin.get(`/api/scans/${scanId}/shares`);
      const opened = shares.filter((s) => s.views > 0);
      expect(opened.length).toBeGreaterThan(0);
      await page.goto(`/#repo/${repo.id}`);
      await page.getByRole('button', { name: 'Report', exact: true }).click();
      const dlg = page.getByRole('dialog', { name: 'Report for scan #1' });
      await dlg.getByRole('button', { name: 'Share link' }).click();
      await expect(dlg.locator('.share-list')).toContainText(/Viewed [1-9]\d* times?/);
      await expect(dlg.locator('.share-list')).toContainText('Revoked');
    });
  });
});
