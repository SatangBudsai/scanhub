import { test, expect, login } from '../lib/test.js';
import { projectWithRepo, standardReports, uploadReports } from '../lib/api.js';

test.describe('ความเรียบร้อยของหน้าเว็บ', () => {
  test('ไม่มี error ใน console ทุกหน้า', async ({ page, step, admin }) => {
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

    await visit('หน้า login', () => page.goto('/#login'), () => page.getByRole('heading', { name: 'เข้าสู่ระบบ' }));
    await step(page, 'login', async () => { await login(page); });
    await visit('หน้าโปรเจกต์', () => page.goto('/#projects'), () => page.getByRole('heading', { name: 'โปรเจกต์', exact: true }));
    await visit('หน้า repo และผลสแกน', () => page.goto(`/#repo/${repo.id}`), () => page.locator('.scanbar'));
    await visit('เปิดรายละเอียดปัญหา', async () => { await page.locator('[data-view="all"]').click(); await page.locator('#fList .f-row').first().click(); }, () => page.locator('.f.open .f-detail'));
    await visit('หน้าต่างรายงาน', () => page.getByRole('button', { name: 'รายงาน' }).click(), () => page.getByRole('dialog', { name: 'รายงานสแกน #1' }));
    await visit('หน้าเชื่อมต่อ CI', () => page.goto(`/#connect/${repo.id}`), () => page.getByRole('heading', { name: 'เชื่อมต่อ CI' }));
    await visit('หน้าตั้งค่า', () => page.goto('/#settings'), () => page.getByRole('heading', { name: 'ตั้งค่า', exact: true }));
    await visit('หน้าผู้ใช้', () => page.goto('/#users'), () => page.getByRole('heading', { name: 'ผู้ใช้', exact: true }));
    await visit('แท็บกลุ่ม', () => page.goto('/#users/groups'), () => page.getByRole('tab', { name: /กลุ่ม/ }));
    await visit('หน้ารายงาน', () => page.goto(`/report.html?scan=${up.json.scanId}`), () => page.locator('main.sheet h1'));
    await visit('ลิงก์แชร์ที่ล็อกด้วยรหัสผ่าน', () => page.goto(new URL(share.url).pathname), () => page.getByRole('heading', { name: 'รายงานนี้ล็อกด้วยรหัสผ่าน' }));
    await visit('หน้าที่ไม่มีอยู่', () => page.goto('/#nope'), () => page.getByRole('heading', { name: 'ไม่พบหน้านี้' }));
  });
});
