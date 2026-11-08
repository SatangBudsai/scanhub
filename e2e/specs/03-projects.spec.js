import { test, expect, login } from '../lib/test.js';
import { uid } from '../lib/api.js';

test.describe('โปรเจกต์และ repo', () => {
  test('สร้าง แก้ชื่อ เพิ่ม repo ตั้งค่า repo แล้วลบ', async ({ page, step, admin }) => {
    const name = uid('Payment Platform');
    const renamed = `${name} v2`;
    const repoName = uid('payment-api').toLowerCase();
    const group = () => page.locator('section.group', { has: page.getByRole('heading', { name: renamed, exact: true }) });

    await step(page, 'login แล้วกดสร้างโปรเจกต์', async () => {
      await page.goto('/#login');
      await login(page, undefined, undefined, { expectHash: /#projects/ });
      await page.locator('#newProj').click();
      await expect(page.getByRole('dialog', { name: 'สร้างโปรเจกต์' })).toBeVisible();
    });
    await step(page, 'ชื่อสั้นเกินไปถูกปฏิเสธ', async () => {
      await page.getByRole('textbox', { name: 'ชื่อโปรเจกต์' }).fill('a');
      await page.getByRole('button', { name: 'สร้าง', exact: true }).click();
      await expect(page.locator('#mErr')).toHaveText('ตั้งชื่ออย่างน้อย 2 ตัวอักษร');
    });
    await step(page, 'ตั้งชื่อแล้วสร้างโปรเจกต์', async () => {
      await page.getByRole('textbox', { name: 'ชื่อโปรเจกต์' }).fill(name);
      await page.getByRole('button', { name: 'สร้าง', exact: true }).click();
      await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
    });
    await step(page, 'แก้ชื่อโปรเจกต์จากเมนู ⋯', async () => {
      await page.getByRole('button', { name: `ตัวเลือกของ ${name}` }).click();
      await page.locator('.pop:not([hidden])').getByRole('button', { name: 'แก้ชื่อโปรเจกต์' }).click();
      await page.getByRole('textbox', { name: 'ชื่อโปรเจกต์' }).fill(renamed);
      await page.getByRole('button', { name: 'บันทึก', exact: true }).click();
      await expect(page.getByRole('heading', { name: renamed, exact: true })).toBeVisible();
    });
    await step(page, 'เพิ่ม repo จากเมนูของโปรเจกต์', async () => {
      await page.getByRole('button', { name: `ตัวเลือกของ ${renamed}` }).click();
      await page.locator('.pop:not([hidden])').getByRole('button', { name: 'เพิ่ม repo' }).click();
      const dlg = page.getByRole('dialog', { name: 'เพิ่ม repo' });
      await expect(dlg.getByLabel('โปรเจกต์')).toHaveValue(/\d+/);
      await dlg.getByLabel('ชื่อ repo').fill('Bad Name');
      await dlg.getByRole('button', { name: 'เพิ่มแล้วไปเชื่อมต่อ' }).click();
      await expect(dlg.locator('#mErr')).toContainText('ชื่อ repo ใช้ได้เฉพาะ');
      await dlg.getByLabel('ชื่อ repo').fill(repoName);
      await dlg.getByLabel('ภาษาหลัก').selectOption('Go');
      await dlg.getByRole('button', { name: 'เพิ่มแล้วไปเชื่อมต่อ' }).click();
    });
    await step(page, 'ไปหน้าเชื่อมต่อ CI พร้อม token ที่แสดงครั้งเดียว', async () => {
      await expect(page).toHaveURL(/#connect\//);
      await expect(page.getByRole('heading', { name: 'เชื่อมต่อ CI' })).toBeVisible();
      await expect(page.locator('#tokVal')).toHaveValue(/^shr_/);
      await expect(page.getByText('คัดลอกเก็บไว้ จะแสดงครั้งเดียว', { exact: false })).toBeVisible();
    });
    await step(page, 'หน้า repo ยังไม่มีผลสแกน', async () => {
      await page.locator('.crumb').getByRole('link', { name: repoName }).click();
      await expect(page.getByRole('heading', { name: 'ยังไม่มีผลสแกน' })).toBeVisible();
    });
    await step(page, 'ตั้งค่า repo: สแกนทุกวันแต่ไม่มี Git URL ถูกปฏิเสธ', async () => {
      await page.getByRole('button', { name: 'ตัวเลือกเพิ่มเติม' }).click();
      await page.getByRole('button', { name: 'ตั้งค่า repo' }).click();
      const dlg = page.getByRole('dialog', { name: 'ตั้งค่า repo' });
      await dlg.getByLabel('สแกนอัตโนมัติ').selectOption('daily');
      await dlg.getByRole('button', { name: 'บันทึก', exact: true }).click();
      await expect(dlg.locator('#mErr')).toHaveText('สแกนอัตโนมัติทุกวันต้องมี Git URL');
    });
    await step(page, 'ตั้ง branch, Git URL, สแกนทุกวัน และเลือก scanner เอง', async () => {
      const dlg = page.getByRole('dialog', { name: 'ตั้งค่า repo' });
      await dlg.getByLabel('Branch หลัก').fill('develop');
      await dlg.getByLabel(/Git URL/).fill('https://gitlab.example.com/pay/payment-api.git');
      await dlg.getByRole('button', { name: 'เลือกเอง' }).click();
      await dlg.locator('[data-rt="checkov"]').click();
      await expect(dlg.locator('[data-rt="checkov"]')).toHaveAttribute('aria-pressed', 'false');
      await dlg.getByRole('button', { name: 'บันทึก', exact: true }).click();
      await expect(dlg).toBeHidden();
      await expect(page.locator('.head .meta')).toContainText('develop');
    });
    await step(page, 'server บันทึกค่าของ repo ครบ', async () => {
      const p = (await admin.get('/api/projects')).find((x) => x.name === renamed);
      const repo = await admin.get(`/api/repos/${p.repos[0].id}`);
      expect(repo).toMatchObject({ name: repoName, branch: 'develop', gitUrl: 'https://gitlab.example.com/pay/payment-api.git', schedule: 'daily' });
      expect(repo.tools).not.toContain('checkov');
      expect(repo.tools).toContain('trivy');
    });
    await step(page, 'ลบโปรเจกต์ที่ยังมี repo ไม่ได้', async () => {
      await page.getByRole('link', { name: 'โปรเจกต์', exact: true }).click();
      await page.getByRole('button', { name: `ตัวเลือกของ ${renamed}` }).click();
      await page.locator('.pop:not([hidden])').getByRole('button', { name: 'ลบโปรเจกต์' }).click();
      await expect(page.locator('#toast')).toContainText('ลบได้เฉพาะโปรเจกต์ที่ไม่มี repo');
    });
    await step(page, 'ลบ repo จากตั้งค่า repo (กดยืนยันสองครั้ง)', async () => {
      await group().getByRole('link', { name: new RegExp(repoName) }).click();
      await page.getByRole('button', { name: 'ตัวเลือกเพิ่มเติม' }).click();
      await page.getByRole('button', { name: 'ตั้งค่า repo' }).click();
      const del = page.locator('#rsDel');
      await del.click();
      await expect(del).toContainText('กดอีกครั้งเพื่อลบ');
      await del.click();
      await expect(page).toHaveURL(/#projects/);
      await expect(group().getByText('ยังไม่มี repo')).toBeVisible();
    });
    await step(page, 'ลบโปรเจกต์ที่ว่างแล้ว', async () => {
      await page.getByRole('button', { name: `ตัวเลือกของ ${renamed}` }).click();
      await page.locator('.pop:not([hidden])').getByRole('button', { name: 'ลบโปรเจกต์' }).click();
      await page.getByRole('dialog', { name: 'ลบโปรเจกต์' }).getByRole('button', { name: 'ลบโปรเจกต์' }).click();
      await expect(page.getByRole('heading', { name: renamed, exact: true })).toHaveCount(0);
    });
  });
});
