import { test, expect, login } from '../lib/test.js';
import { projectWithRepo, uid } from '../lib/api.js';
import { fakeGitFromApp } from '../lib/env.js';

test.describe('ตั้งค่า', () => {
  test('scanner เปิดปิดได้และแสดงเวอร์ชัน', async ({ page, step, admin }) => {
    const toolRow = (name) => page.locator('.tool-row', { has: page.locator('.nm', { hasText: new RegExp(`^${name}$`) }) });

    await step(page, 'หน้าตั้งค่าแสดง scanner ทั้ง 7 ตัวพร้อมเวอร์ชันที่มากับ image', async () => {
      await page.goto('/#login');
      await login(page);
      await page.getByRole('link', { name: 'ตั้งค่า', exact: true }).click();
      await expect(page.locator('.tool-row')).toHaveCount(7);
      for (const n of ['Trivy', 'Grype', 'Gitleaks', 'Semgrep', 'Checkov']) {
        await expect(toolRow(n).locator('.mono')).toHaveText(/\d+\.\d+/);
        await expect(toolRow(n)).toContainText('พร้อมใช้งาน');
      }
    });
    await step(page, 'ปิด Checkov', async () => {
      const before = (await admin.get('/api/tools')).filter((t) => t.enabled).length;
      await page.getByRole('switch', { name: 'เปิดใช้ Checkov' }).click();
      await expect(page.locator('#toast')).toContainText('ปิดใช้ Checkov แล้ว');
      await expect(toolRow('Checkov')).toContainText('ปิดอยู่');
      await expect(page.locator('#instCnt')).toHaveText(`เปิดใช้ ${before - 1} จาก 7`);
      expect((await admin.get('/api/tools')).find((t) => t.id === 'checkov').enabled).toBe(false);
    });
    await step(page, 'เปิด Checkov กลับ', async () => {
      await page.getByRole('switch', { name: 'เปิดใช้ Checkov' }).click();
      await expect(toolRow('Checkov')).toContainText('พร้อมใช้งาน');
      expect((await admin.get('/api/tools')).find((t) => t.id === 'checkov').enabled).toBe(true);
    });
  });

  test('ตั้งเวลาอัปเดตอัตโนมัติ และดูบันทึก', async ({ page, step, admin }) => {
    const original = (await admin.get('/api/settings')).schedule;
    await step(page, 'ตั้งเวลาอัปเดตเป็น 04:15', async () => {
      await page.goto('/#login');
      await login(page);
      await page.goto('/#settings');
      await page.getByLabel('เวลาอัปเดต').fill('04:15');
      await expect(page.locator('#toast')).toContainText('อัปเดตทุกวันเวลา 04:15');
      await expect(page.locator('.sec', { hasText: 'อัปเดตอัตโนมัติ' }).locator('.sec-h')).toContainText('ทุกวันเวลา 04:15');
    });
    await step(page, 'ปิดอัปเดตอัตโนมัติ', async () => {
      await page.getByRole('switch', { name: 'อัปเดตทุกวัน' }).click();
      await expect(page.locator('#toast')).toContainText('ปิดอัปเดตอัตโนมัติ');
      await expect(page.getByRole('switch', { name: 'อัปเดตทุกวัน' })).toHaveAttribute('aria-checked', 'false');
      expect((await admin.get('/api/settings')).schedule).toMatchObject({ enabled: false, time: '04:15' });
    });
    await step(page, 'เปิดกลับ และเปิดบันทึกการอัปเดต', async () => {
      await page.getByRole('switch', { name: 'อัปเดตทุกวัน' }).click();
      await expect(page.getByRole('switch', { name: 'อัปเดตทุกวัน' })).toHaveAttribute('aria-checked', 'true');
      await page.locator('#logBox summary').click();
      await expect(page.locator('#logBox .log')).toBeVisible();
      await expect(page.locator('#logBox .log')).toContainText(/enable|disable|ยังไม่มีบันทึก/);
    });
    await admin.put('/api/settings', { schedule: original });
  });

  test('SonarQube ตั้งค่าจาก env ถูกล็อก และ NVD key บันทึกแล้วล้างได้', async ({ page, step, admin }) => {
    const st = await admin.get('/api/settings');
    await step(page, 'ช่อง SonarQube แสดงค่าจาก env และแก้ไม่ได้', async () => {
      await page.goto('/#login');
      await login(page);
      await page.goto('/#settings');
      const sec = page.locator('#secConn');
      if (st.sonar.fromEnv) {
        await expect(sec.locator('#secSonar')).toContainText('ตั้งค่าจาก env');
        await expect(sec.getByLabel('URL')).toHaveAttribute('readonly', '');
        await expect(sec.getByLabel('URL')).toHaveValue(st.sonar.url);
        await expect(sec.getByLabel('Token')).toHaveAttribute('placeholder', 'ตั้งค่าจาก env');
      } else {
        await expect(sec.locator('#secSonar')).toContainText('SONAR_URL');
      }
    });
    await step(page, 'แถว SonarQube ในรายการ scanner ไม่ขอให้ตั้งค่าแล้ว', async () => {
      const r = page.locator('.tool-row', { hasText: 'SonarQube' });
      if (st.sonar.fromEnv) await expect(r).not.toContainText('ใส่ URL และ token ของ SonarQube server');
    });
    await step(page, 'ใส่ NVD API key แล้วบันทึก', async () => {
      await page.getByLabel('NVD API key').fill('e2e-nvd-key-0000');
      await page.getByRole('button', { name: 'บันทึกการเชื่อมต่อ' }).click();
      await expect(page.locator('#toast')).toContainText('บันทึกการเชื่อมต่อแล้ว');
      await expect(page.getByLabel('NVD API key')).toHaveAttribute('placeholder', /ตั้งค่าแล้ว/);
      expect((await admin.get('/api/settings')).nvdKeySet).toBe(true);
    });
    await step(page, 'ล้าง NVD key', async () => {
      await page.getByRole('button', { name: 'ล้าง key' }).click();
      await expect(page.locator('#toast')).toContainText('ล้างแล้ว');
      expect((await admin.get('/api/settings')).nvdKeySet).toBe(false);
    });
  });

  test('เพิ่มการเชื่อมต่อ GitHub แล้วทดสอบกับ API จำลอง', async ({ page, step, admin }) => {
    const name = uid('GitHub บริษัท');
    await step(page, 'เปิดหน้าต่างเพิ่มการเชื่อมต่อ Git', async () => {
      await page.goto('/#login');
      await login(page);
      await page.goto('/#settings');
      await page.locator('#secGit [data-gitadd]').first().click();
      await expect(page.getByRole('dialog', { name: 'เพิ่มการเชื่อมต่อ Git' })).toBeVisible();
    });
    await step(page, 'กรอกชื่อ API URL และ token แล้วเพิ่ม', async () => {
      const dlg = page.getByRole('dialog', { name: 'เพิ่มการเชื่อมต่อ Git' });
      await expect(dlg.getByLabel('API URL')).toHaveValue('https://api.github.com');
      await expect(dlg).toContainText('ต้องให้สิทธิ์อะไรบ้าง');
      await dlg.getByLabel('ชื่อที่แสดง').fill(name);
      await dlg.getByLabel('API URL').fill(`${fakeGitFromApp()}/gh`);
      await dlg.getByLabel('Token').fill('ghp_e2e_fake_token');
      await dlg.getByRole('button', { name: 'เพิ่มและทดสอบ' }).click();
      await expect(dlg).toBeHidden();
    });
    await step(page, 'ทดสอบผ่าน: บัญชี octo สิทธิ์ครบ', async () => {
      const r = page.locator('.git-row', { hasText: name });
      await expect(r).toContainText('ทดสอบแล้ว · บัญชี octo');
      await expect(r).toContainText('ใช้ได้');
    });
    await step(page, 'ลบการเชื่อมต่อ', async () => {
      const list = await admin.get('/api/integrations');
      const c = list.find((x) => x.name === name);
      await page.getByRole('button', { name: `ลบ ${name}` }).click();
      await page.getByRole('dialog', { name: 'ลบการเชื่อมต่อ' }).getByRole('button', { name: 'ลบ', exact: true }).click();
      await expect(page.locator('.git-row', { hasText: name })).toHaveCount(0);
      expect((await admin.get('/api/integrations')).some((x) => x.id === c.id)).toBe(false);
    });
  });

  test('ค่าทั่วไป: server URL เวลาสแกน และระยะเก็บประวัติ', async ({ page, step, admin }) => {
    const original = await admin.get('/api/settings');
    try {
      await step(page, 'URL ที่ไม่ใช่ http ถูกปฏิเสธ', async () => {
        await page.goto('/#login');
        await login(page);
        await page.goto('/#settings');
        await page.getByLabel('Server URL').fill('ftp://nope');
        await page.locator('#saveGen').click();
        await expect(page.locator('#toast')).toContainText('Server URL ต้องขึ้นต้นด้วย http:// หรือ https://');
      });
      await step(page, 'เปลี่ยน server URL เวลาสแกน และเก็บประวัติ 90 วัน', async () => {
        await page.getByLabel('Server URL').fill('https://scanhub.e2e.example');
        await page.getByLabel('เวลาสแกนอัตโนมัติรายวัน').fill('01:45');
        await page.getByLabel('เก็บประวัติการสแกน').selectOption('90');
        await page.locator('#saveGen').click();
        await expect(page.locator('#toast')).toContainText('บันทึกแล้ว');
        const s = await admin.get('/api/settings');
        expect(s).toMatchObject({ serverUrl: 'https://scanhub.e2e.example', scanTime: '01:45', retentionDays: 90 });
      });
      await step(page, 'โค้ด CI ใช้ server URL ใหม่ทันที', async () => {
        const { repo } = await projectWithRepo(admin);
        await page.goto(`/#connect/${repo.id}`);
        await expect(page.locator('#snip')).toContainText('https://scanhub.e2e.example');
      });
    } finally {
      await admin.put('/api/settings', { serverUrl: original.serverUrl, scanTime: original.scanTime, retentionDays: original.retentionDays });
    }
    await step(page, 'คืนค่าเดิม', async () => {
      await page.goto('/#settings');
      await expect(page.getByLabel('Server URL')).toHaveValue(original.serverUrl);
    });
  });
});
