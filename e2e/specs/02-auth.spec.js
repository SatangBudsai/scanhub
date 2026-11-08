import { test, expect, login } from '../lib/test.js';
import { apiAs, projectWithRepo, standardReports, uid, uploadReports } from '../lib/api.js';
import { ADMIN } from '../lib/env.js';

test.describe('เข้าสู่ระบบ', () => {
  test('admin จาก env login ได้ และเห็นป้ายตั้งค่าจาก env', async ({ page, step, admin }) => {
    await step(page, 'เปิดหน้า login', async () => {
      await page.goto('/');
      await expect(page).toHaveURL(/#login/);
      await expect(page.getByRole('heading', { name: 'เข้าสู่ระบบ' })).toBeVisible();
    });
    await step(page, 'login ด้วยชื่อและรหัสจาก env', async () => {
      await login(page, ADMIN.username, ADMIN.password, { expectHash: /#projects/ });
      await expect(page.getByRole('heading', { name: 'โปรเจกต์', exact: true })).toBeVisible();
    });
    await step(page, 'เมนูบัญชีแสดง ADMIN และตั้งค่าจาก env', async () => {
      await page.getByRole('button', { name: `บัญชีของ ${ADMIN.username}` }).click();
      const menu = page.getByRole('menu', { name: 'บัญชี' });
      await expect(menu.locator('.role-tag')).toHaveText('ผู้ดูแลระบบ');
      await expect(menu.getByText('ตั้งค่าจาก env')).toBeVisible();
      // the env admin cannot change the password from the web
      await expect(menu.getByRole('menuitem', { name: 'เปลี่ยนรหัสผ่าน' })).toHaveCount(0);
    });
  });

  test('รหัสผ่านผิดแสดงข้อความ และยังอยู่หน้า login', async ({ page, step }) => {
    await step(page, 'กรอกรหัสผ่านผิด', async () => {
      await page.goto('/#login');
      await page.getByLabel('ชื่อผู้ใช้').fill(ADMIN.username);
      await page.getByLabel('รหัสผ่าน', { exact: true }).fill('wrong-password-1');
      await page.getByRole('button', { name: 'เข้าสู่ระบบ' }).click();
    });
    await step(page, 'เห็นข้อความรหัสผ่านไม่ถูกต้อง', async () => {
      await expect(page.locator('#lerr')).toHaveText('ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง');
      await expect(page).toHaveURL(/#login/);
    });
    await step(page, 'ช่องว่างแจ้งให้กรอกให้ครบ', async () => {
      await page.getByLabel('รหัสผ่าน', { exact: true }).fill('');
      await page.getByRole('button', { name: 'เข้าสู่ระบบ' }).click();
      await expect(page.locator('#lerr')).toHaveText('กรอกชื่อผู้ใช้และรหัสผ่าน');
    });
  });

  test('ผู้ใช้ใหม่ต้องตั้งรหัสผ่านใหม่ก่อนใช้งาน', async ({ page, step, admin }) => {
    const username = uid('newbie');
    await admin.post('/api/users', { username, password: 'temp-pass-123', role: 'ANALYST' });

    await step(page, 'login ด้วยรหัสชั่วคราวจาก admin', async () => {
      await page.goto('/#login');
      await login(page, username, 'temp-pass-123', { expectHash: /#password/ });
      await expect(page.getByRole('heading', { name: 'ตั้งรหัสผ่านใหม่' })).toBeVisible();
    });
    await step(page, 'เข้าหน้าอื่นไม่ได้จนกว่าจะตั้งรหัสใหม่', async () => {
      await page.evaluate(() => { location.hash = '#projects'; });
      await expect(page).toHaveURL(/#password/);
    });
    await step(page, 'รหัสใหม่สองช่องไม่ตรงกัน', async () => {
      await page.getByLabel('รหัสผ่านชั่วคราว').fill('temp-pass-123');
      await page.getByLabel('รหัสผ่านใหม่', { exact: true }).fill('brand-new-pass-1');
      await page.getByLabel('ยืนยันรหัสผ่านใหม่').fill('brand-new-pass-2');
      await page.getByRole('button', { name: 'บันทึกรหัสผ่าน' }).click();
      await expect(page.locator('#perr')).toHaveText('รหัสผ่านใหม่ทั้งสองช่องไม่ตรงกัน');
    });
    await step(page, 'รหัสชั่วคราวผิด server ตอบกลับโดยไม่ logout', async () => {
      await page.getByLabel('รหัสผ่านชั่วคราว').fill('not-the-temp-1');
      await page.getByLabel('ยืนยันรหัสผ่านใหม่').fill('brand-new-pass-1');
      await page.getByRole('button', { name: 'บันทึกรหัสผ่าน' }).click();
      await expect(page.locator('#perr')).toHaveText('รหัสผ่านปัจจุบันไม่ถูกต้อง');
      await expect(page).toHaveURL(/#password/);
    });
    await step(page, 'ตั้งรหัสใหม่สำเร็จ เข้าหน้าโปรเจกต์ได้', async () => {
      await page.getByLabel('รหัสผ่านชั่วคราว').fill('temp-pass-123');
      await page.getByRole('button', { name: 'บันทึกรหัสผ่าน' }).click();
      await expect(page).toHaveURL(/#projects/);
      await expect(page.getByRole('heading', { name: 'ยังไม่มีโปรเจกต์ที่คุณเห็น' })).toBeVisible();
    });
    await step(page, 'login ใหม่ด้วยรหัสใหม่ได้', async () => {
      const again = await apiAs(username, 'brand-new-pass-1');
      const me = await again.get('/api/auth/me');
      expect(me.user.mustChange).toBe(false);
      await again.dispose();
    });
  });

  test('ออกจากระบบจากเมนูบัญชี', async ({ page, step }) => {
    await step(page, 'login แล้วเปิดเมนูบัญชี', async () => {
      await page.goto('/#login');
      await login(page);
      await page.getByRole('button', { name: `บัญชีของ ${ADMIN.username}` }).click();
      await expect(page.getByRole('menu', { name: 'บัญชี' })).toBeVisible();
    });
    await step(page, 'กดออกจากระบบ', async () => {
      await page.getByRole('menuitem', { name: 'ออกจากระบบ' }).click();
      await expect(page).toHaveURL(/#login/);
    });
    await step(page, 'เปิดหน้าโปรเจกต์ตรงๆ ถูกส่งกลับไปหน้า login', async () => {
      await page.goto('/#projects');
      await expect(page).toHaveURL(/#login/);
      const res = await page.request.get('/api/projects');
      expect(res.status()).toBe(401);
    });
  });

  test('session หมดอายุ แล้วกลับไปหน้า login เอง', async ({ page, step, context }) => {
    await step(page, 'login แล้วอยู่หน้าโปรเจกต์', async () => {
      await page.goto('/#login');
      await login(page, undefined, undefined, { expectHash: /#projects/ });
    });
    await step(page, 'session ถูกลบ (เช่นหมดอายุ)', async () => {
      await context.clearCookies();
    });
    await step(page, 'กดไปหน้าตั้งค่า ระบบพากลับไปหน้า login', async () => {
      await page.getByRole('link', { name: 'ตั้งค่า', exact: true }).click();
      await expect(page).toHaveURL(/#login/);
      await expect(page.getByRole('heading', { name: 'เข้าสู่ระบบ' })).toBeVisible();
    });
  });

  test('login จากลิงก์รายงานแล้วกลับไปที่รายงาน (next=)', async ({ page, step, admin }) => {
    const { repo, token } = await projectWithRepo(admin);
    const up = await uploadReports(token, standardReports(), { query: 'gate=report' });
    expect(up.status).toBe(200);
    const share = (await admin.post(`/api/scans/${up.json.scanId}/shares`, { mode: 'internal', options: { title: `รายงาน ${repo.name}` } })).share;
    const path = new URL(share.url).pathname;

    await step(page, 'เปิดลิงก์แชร์ตอนยังไม่ login', async () => {
      await page.goto(path);
      await expect(page.getByRole('heading', { name: 'ต้อง login' })).toBeVisible();
    });
    await step(page, 'กดเข้าสู่ระบบ ไปหน้า login ที่มี next', async () => {
      await page.getByRole('link', { name: 'เข้าสู่ระบบ' }).click();
      await expect(page).toHaveURL(/#login\?next=/);
    });
    await step(page, 'login แล้วกลับมาที่รายงานเดิม', async () => {
      await page.getByLabel('ชื่อผู้ใช้').fill(ADMIN.username);
      await page.getByLabel('รหัสผ่าน', { exact: true }).fill(ADMIN.password);
      await page.getByRole('button', { name: 'เข้าสู่ระบบ' }).click();
      await expect(page).toHaveURL(new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'));
      await expect(page.getByRole('heading', { name: `รายงาน ${repo.name}` })).toBeVisible();
    });
    await step(page, 'next ที่ชี้ออกนอกเว็บถูกเพิกเฉย', async () => {
      await page.goto('/#login?next=//evil.example/x');
      await expect(page).toHaveURL(/#projects/);
    });
  });
});
