import { test, expect, login } from '../lib/test.js';
import { adminApi } from '../lib/api.js';

test.describe('ตั้งค่าครั้งแรก', () => {
  test('admin เลือก scanner และตั้งเวลาอัปเดตอัตโนมัติในวิซาร์ด', async ({ page, step }) => {
    const api = await adminApi();
    const before = await api.get('/api/setup');
    test.skip(before.done, 'instance นี้ตั้งค่าครั้งแรกไปแล้ว');

    await step(page, 'เปิด ScanHub ครั้งแรกแล้ว login ด้วย admin จาก env', async () => {
      await page.goto('/');
      await expect(page).toHaveURL(/#login/);
      await login(page, undefined, undefined, { expectHash: /#setup/ });
      await expect(page.getByRole('heading', { name: 'เลือก scanner ที่จะเปิดใช้' })).toBeVisible();
    });

    await step(page, 'scanner ที่ไม่ต้องตั้งค่าเพิ่มถูกเลือกไว้ให้ ยกเว้น SonarQube', async () => {
      await expect(page.getByText('เลือกแล้ว 6 จาก 7')).toBeVisible();
      await expect(page.locator('[data-pick="sonarqube"]')).toHaveAttribute('aria-pressed', 'false');
      await expect(page.locator('[data-pick="trivy"]')).toHaveAttribute('aria-pressed', 'true');
    });

    await step(page, 'ปิด Checkov แล้วเปิดกลับ ตัวนับเปลี่ยนตาม', async () => {
      await page.locator('[data-pick="checkov"]').click();
      await expect(page.getByText('เลือกแล้ว 5 จาก 7')).toBeVisible();
      await page.locator('[data-pick="checkov"]').click();
      await expect(page.getByText('เลือกแล้ว 6 จาก 7')).toBeVisible();
    });

    await step(page, 'ไปขั้นที่ 2 ตั้งเวลาอัปเดตเป็น 02:30', async () => {
      await page.getByRole('button', { name: 'ถัดไป' }).click();
      await expect(page.getByRole('heading', { name: 'อัปเดต scanner อัตโนมัติ' })).toBeVisible();
      await expect(page.getByRole('switch', { name: 'อัปเดตทุกวัน' })).toHaveAttribute('aria-checked', 'true');
      await page.locator('#wTime').fill('02:30');
    });

    await step(page, 'กดเปิดใช้งาน แล้วเห็นสรุป', async () => {
      await page.getByRole('button', { name: 'เปิดใช้งาน' }).click();
      await expect(page.getByRole('heading', { name: 'พร้อมใช้งาน' })).toBeVisible();
      await expect(page.getByText('เปิดใช้ 6 scanner · อัปเดตทุกวันเวลา 02:30 รวมฐานข้อมูลช่องโหว่')).toBeVisible();
      await expect(page.locator('#instList .done-row')).toHaveCount(6);
    });

    await step(page, 'เข้าสู่ ScanHub ไปที่หน้าโปรเจกต์', async () => {
      await page.getByRole('button', { name: 'เข้าสู่ ScanHub' }).click();
      await expect(page).toHaveURL(/#projects/);
      await expect(page.getByRole('heading', { name: 'โปรเจกต์', exact: true })).toBeVisible();
    });

    await step(page, 'server บันทึกตารางเวลาและ scanner ที่เปิดใช้', async () => {
      const s = await api.get('/api/settings');
      expect(s.schedule).toMatchObject({ enabled: true, time: '02:30', updateDb: true });
      const tools = await api.get('/api/tools');
      const on = tools.filter((t) => t.enabled).map((t) => t.id).sort();
      expect(on).toEqual(['checkov', 'dependency-check', 'gitleaks', 'grype', 'semgrep', 'trivy']);
      expect(tools.every((t) => t.installed)).toBe(true);
    });
    await api.dispose();
  });
});
