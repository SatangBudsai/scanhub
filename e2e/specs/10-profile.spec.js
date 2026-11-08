import { test, expect, login, newUserPage } from '../lib/test.js';
import { makeUser } from '../lib/api.js';
import { ADMIN } from '../lib/env.js';

const theme = (page) => page.evaluate(() => document.documentElement.getAttribute('data-theme'));
const bg = (page) => page.evaluate(() => getComputedStyle(document.body).backgroundColor);

test.describe('เมนูบัญชี', () => {
  test('สลับธีม สว่าง / มืด / ตามระบบ และจำไว้หลังโหลดหน้าใหม่', async ({ page, step }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    const menuBtn = () => page.getByRole('button', { name: `บัญชีของ ${ADMIN.username}` });

    await step(page, 'เปิดเมนูบัญชี', async () => {
      await page.goto('/#login');
      await login(page);
      await menuBtn().click();
      await expect(page.getByRole('menu', { name: 'บัญชี' })).toBeVisible();
      await expect(page.getByRole('menuitemradio', { name: 'ตามระบบ' })).toHaveAttribute('aria-checked', 'true');
    });
    await step(page, 'เลือกธีมมืด', async () => {
      await page.getByRole('menuitemradio', { name: 'มืด' }).click();
      expect(await theme(page)).toBe('dark');
      expect(await bg(page)).toBe('rgb(20, 20, 21)');
    });
    await step(page, 'โหลดหน้าใหม่ ธีมมืดยังอยู่', async () => {
      await page.reload();
      await expect(page.getByRole('heading', { name: 'โปรเจกต์', exact: true })).toBeVisible();
      expect(await theme(page)).toBe('dark');
    });
    await step(page, 'เลือกธีมสว่าง', async () => {
      await menuBtn().click();
      await page.getByRole('menuitemradio', { name: 'สว่าง' }).click();
      expect(await theme(page)).toBe('light');
      expect(await bg(page)).toBe('rgb(250, 250, 250)');
    });
    await step(page, 'ตามระบบ: ใช้สีตามที่เครื่องตั้งไว้', async () => {
      await page.getByRole('menuitemradio', { name: 'ตามระบบ' }).click();
      expect(await theme(page)).toBeNull();
      await page.emulateMedia({ colorScheme: 'dark' });
      await expect.poll(() => bg(page)).toBe('rgb(20, 20, 21)');
      await page.emulateMedia({ colorScheme: 'light' });
      await expect.poll(() => bg(page)).toBe('rgb(250, 250, 250)');
      await page.reload();
      expect(await theme(page)).toBeNull();
    });
  });

  test('ใช้เมนูด้วยคีย์บอร์ด: ลูกศรเลื่อน Esc ปิดแล้วโฟกัสกลับที่ปุ่ม', async ({ page, step }) => {
    const btn = () => page.getByRole('button', { name: `บัญชีของ ${ADMIN.username}` });
    await step(page, 'โฟกัสปุ่มบัญชีแล้วกดลูกศรลง เมนูเปิด', async () => {
      await page.goto('/#login');
      await login(page);
      await btn().focus();
      await page.keyboard.press('ArrowDown');
      await expect(page.getByRole('menu', { name: 'บัญชี' })).toBeVisible();
      await expect(page.locator('#mePop :focus')).toHaveCount(1);
    });
    await step(page, 'ลูกศรขวาเปลี่ยนธีมในแถบธีม', async () => {
      await page.getByRole('menuitemradio', { name: 'สว่าง' }).focus();
      await page.keyboard.press('ArrowRight');
      await expect(page.getByRole('menuitemradio', { name: 'มืด' })).toBeFocused();
      expect(await theme(page)).toBe('dark');
    });
    await step(page, 'กด Esc เมนูปิด โฟกัสกลับที่ปุ่ม', async () => {
      await page.keyboard.press('Escape');
      await expect(page.getByRole('menu', { name: 'บัญชี' })).toBeHidden();
      await expect(btn()).toBeFocused();
      await expect(btn()).toHaveAttribute('aria-expanded', 'false');
    });
    await step(page, 'คลิกนอกเมนูก็ปิด', async () => {
      await btn().click();
      await expect(page.getByRole('menu', { name: 'บัญชี' })).toBeVisible();
      await page.locator('main').click({ position: { x: 5, y: 5 } });
      await expect(page.getByRole('menu', { name: 'บัญชี' })).toBeHidden();
      await page.evaluate(() => localStorage.removeItem('scanhub.theme'));
    });
  });

  test('เปลี่ยนรหัสผ่านมีเฉพาะผู้ใช้ที่ไม่ได้ตั้งค่าจาก env', async ({ page, step, browser, admin }) => {
    const user = await makeUser(admin, { role: 'ANALYST' });
    await step(page, 'admin จาก env ไม่มีเมนูเปลี่ยนรหัสผ่าน', async () => {
      await page.goto('/#login');
      await login(page);
      await page.getByRole('button', { name: `บัญชีของ ${ADMIN.username}` }).click();
      await expect(page.getByRole('menuitem', { name: 'เปลี่ยนรหัสผ่าน' })).toHaveCount(0);
      await page.evaluate(() => { location.hash = '#password'; });
      await expect(page).toHaveURL(/#projects/);
    });
    const u = await newUserPage(browser, user);
    await step(u.page, 'ผู้ใช้ทั่วไปเห็นเมนูเปลี่ยนรหัสผ่าน', async () => {
      await u.page.getByRole('button', { name: `บัญชีของ ${user.username}` }).click();
      const m = u.page.getByRole('menu', { name: 'บัญชี' });
      await expect(m.locator('.role-tag')).toHaveText('ผู้ตรวจสอบ');
      await expect(m.getByText('ตั้งค่าจาก env')).toHaveCount(0);
      await m.getByRole('menuitem', { name: 'เปลี่ยนรหัสผ่าน' }).click();
      await expect(u.page.getByRole('heading', { name: 'เปลี่ยนรหัสผ่าน' })).toBeVisible();
    });
    await step(u.page, 'เปลี่ยนรหัสผ่านสำเร็จ', async () => {
      await u.page.getByLabel('รหัสผ่านปัจจุบัน').fill(user.password);
      await u.page.getByLabel('รหัสผ่านใหม่', { exact: true }).fill('changed-pass-999');
      await u.page.getByLabel('ยืนยันรหัสผ่านใหม่').fill('changed-pass-999');
      await u.page.getByRole('button', { name: 'บันทึกรหัสผ่าน' }).click();
      await expect(u.page.locator('#toast')).toContainText('เปลี่ยนรหัสผ่านแล้ว');
      await expect(u.page).toHaveURL(/#projects/);
    });
    await u.ctx.close();
  });
});
