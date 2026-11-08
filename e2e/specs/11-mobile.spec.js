import { test, expect, login } from '../lib/test.js';
import { adminApi, ensureSetup, projectWithRepo, standardReports, uploadReports } from '../lib/api.js';

const noOverflow = async (page) => {
  const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
  expect(m.sw, `page is ${m.sw}px wide in a ${m.cw}px viewport`).toBeLessThanOrEqual(m.cw);
};

test.describe('มือถือ 390px', () => {
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

  test('ทุกหน้าใช้งานได้บนจอมือถือ และไม่มีการเลื่อนแนวนอน', async ({ page, step }) => {
    await step(page, 'หน้า login', async () => {
      await page.goto('/#login');
      await expect(page.getByRole('heading', { name: 'เข้าสู่ระบบ' })).toBeVisible();
      await noOverflow(page);
    });
    await step(page, 'หน้าโปรเจกต์: เมนูยุบเป็นปุ่มเดียว', async () => {
      await login(page);
      await expect(page.getByRole('link', { name: 'ตั้งค่า', exact: true })).toBeHidden();
      await page.getByRole('button', { name: 'เมนู' }).click();
      const nav = page.locator('#navPop');
      await expect(nav).toBeVisible();
      await expect(nav.getByRole('link', { name: repo.name })).toBeVisible();
      await noOverflow(page);
    });
    await step(page, 'เลือก repo จากเมนู ไปหน้าผลสแกน', async () => {
      await page.locator('#navPop').getByRole('link', { name: repo.name }).click();
      await expect(page.locator('.scanbar .ttl')).toHaveText('สแกน #1');
      await noOverflow(page);
    });
    await step(page, 'รายการปัญหาและรายละเอียด', async () => {
      await page.locator('[data-view="all"]').click();
      const first = page.locator('#fList .f-row').first();
      await first.scrollIntoViewIfNeeded();
      await first.click();
      await expect(page.locator('.f.open .f-detail')).toBeVisible();
      await noOverflow(page);
    });
    await step(page, 'หน้าเชื่อมต่อ CI', async () => {
      await page.goto(`/#connect/${repo.id}`);
      await expect(page.getByRole('heading', { name: 'เชื่อมต่อ CI' })).toBeVisible();
      await noOverflow(page);
    });
    await step(page, 'หน้าผู้ใช้แสดงเป็นการ์ด', async () => {
      await page.goto('/#users');
      await expect(page.getByRole('heading', { name: 'ผู้ใช้', exact: true })).toBeVisible();
      const tr = page.locator('.users-table tbody tr').first();
      const display = await tr.evaluate((el) => getComputedStyle(el).display);
      expect(display).not.toBe('table-row');
      await noOverflow(page);
    });
    await step(page, 'หน้าตั้งค่า', async () => {
      await page.goto('/#settings');
      await expect(page.getByRole('heading', { name: 'ตั้งค่า', exact: true })).toBeVisible();
      await noOverflow(page);
    });
    await step(page, 'รายงานสำหรับลูกค้า', async () => {
      await page.goto(`/report.html?scan=${scanId}`);
      await expect(page.locator('main.sheet h1')).toBeVisible();
      await noOverflow(page);
    });
  });
});
