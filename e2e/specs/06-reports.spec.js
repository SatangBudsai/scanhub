import fs from 'node:fs';
import { test, expect, login, newUserPage } from '../lib/test.js';
import { adminApi, ensureSetup, makeUser, projectWithRepo, sql, standardReports, uploadReports } from '../lib/api.js';
import { LOOK, ownsContainer } from '../lib/env.js';
import { pdfInfo } from '../lib/pdf.js';

test.describe.serial('รายงานและลิงก์แชร์', () => {
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
    title = `รายงานความปลอดภัย ${repo.name}`;
    await api.dispose();
  });

  // open the report modal on the repo page
  async function openReportModal(page) {
    await page.goto(`/#repo/${repo.id}`);
    await page.getByRole('button', { name: 'รายงาน' }).click();
    return page.getByRole('dialog', { name: 'รายงานสแกน #1' });
  }

  test('ส่งออกรายงานสำหรับลูกค้า เป็น PDF และ HTML', async ({ page, step, snap, context }) => {
    let report;
    await step(page, 'เปิดหน้าต่างรายงานจากหน้า repo', async () => {
      await page.goto('/#login');
      await login(page);
      const dlg = await openReportModal(page);
      await expect(dlg.getByLabel('ชื่อรายงาน')).toHaveValue(title);
    });
    await step(page, 'ใส่ชื่อลูกค้า และแสดงเฉพาะ High ขึ้นไป', async () => {
      const dlg = page.getByRole('dialog', { name: 'รายงานสแกน #1' });
      await dlg.getByLabel('จัดทำให้ (ลูกค้า)').fill('บริษัท ทดสอบ จำกัด');
      await dlg.getByLabel('ระดับความรุนแรงที่แสดง').selectOption('high');
    });
    await step(page, 'เปิดรายงานในแท็บใหม่', async () => {
      const popup = context.waitForEvent('page');
      await page.getByRole('button', { name: 'เปิดรายงาน' }).click();
      report = await popup;
      await report.waitForLoadState();
      await expect(report.getByRole('heading', { name: title, level: 1 })).toBeVisible();
    });
    await step(report, 'รายงานมีชื่อลูกค้า สรุป ตัวสแกน และเฉพาะ Critical/High', async () => {
      await expect(report.locator('.prepared')).toHaveText('จัดทำให้ บริษัท ทดสอบ จำกัด');
      await expect(report.getByRole('heading', { name: 'บทสรุป' })).toBeVisible();
      await expect(report.getByRole('heading', { name: 'ตัวสแกนที่ใช้' })).toBeVisible();
      const groups = await report.locator('.sev-h h2').allTextContents();
      expect(groups.length).toBeGreaterThan(0);
      for (const g of groups) expect(['Critical', 'High']).toContain(g.trim());
      await expect(report.locator('.metagrid')).toContainText(repo.name);
    });
    await step(report, 'มุมมองตอนพิมพ์ซ่อนแถบเครื่องมือ', async () => {
      await report.emulateMedia({ media: 'print' });
      await expect(report.locator('#toolbar')).toBeHidden();
      await expect(report.getByRole('heading', { name: title, level: 1 })).toBeVisible();
      await snap(report, 'หน้าตาตอนพิมพ์');
      await report.emulateMedia({ media: 'screen' });
    });
    await step(report, 'สร้าง PDF ขนาด A4 ได้ มีหน้าและชื่อเอกสาร', async () => {
      const pdf = await report.pdf({ format: 'A4', printBackground: true, preferCSSPageSize: true });
      const info = pdfInfo(pdf);
      expect(info.isPdf).toBe(true);
      expect(info.pages).toBeGreaterThan(0);
      expect(info.bytes).toBeGreaterThan(10_000);
      expect(info.title || '').toContain(repo.name);
    });
    await step(report, 'ดาวน์โหลด HTML ได้ไฟล์ที่ไม่มี script', async () => {
      const dl = report.waitForEvent('download');
      await report.getByRole('button', { name: 'ดาวน์โหลด HTML' }).click();
      const d = await dl;
      expect(d.suggestedFilename()).toBe(`scanhub-${repo.name}-scan-1.html`);
      const html = fs.readFileSync(await d.path(), 'utf8');
      expect(html.startsWith('<!doctype html>')).toBe(true);
      expect(html).toContain('บริษัท ทดสอบ จำกัด');
      expect(html).not.toMatch(/<script/i);
      expect(html).not.toContain('id="toolbar"');
    });
  });

  test('ลิงก์แชร์เฉพาะผู้ใช้ในระบบ: ต้อง login และต้องมีสิทธิ์ในโปรเจกต์', async ({ page, step, browser, admin }) => {
    let url;
    const outsider = await makeUser(admin, { role: 'ANALYST', prefix: 'outsider' });
    const member = await makeUser(admin, { role: 'ANALYST', prefix: 'member', projectIds: [project.id] });

    await step(page, 'สร้างลิงก์แบบเฉพาะผู้ใช้ในระบบจากหน้าต่างรายงาน', async () => {
      await page.goto('/#login');
      await login(page);
      const dlg = await openReportModal(page);
      await dlg.getByRole('button', { name: 'ลิงก์แชร์' }).click();
      await dlg.getByRole('button', { name: 'เฉพาะผู้ใช้ในระบบ' }).click();
      await dlg.getByLabel('หมดอายุ').selectOption('7');
      await dlg.getByRole('button', { name: 'สร้างลิงก์' }).click();
      await expect(dlg.locator('#shUrl')).toHaveValue(/\/s\/shs_/);
      url = new URL(await dlg.locator('#shUrl').inputValue()).pathname;
      await expect(dlg.locator('.share-row').first()).toContainText('เฉพาะผู้ใช้ในระบบ');
    });
    await step(page, 'คนที่ยังไม่ login ถูกขอให้ login', async () => {
      const ctx = await browser.newContext({ ...LOOK, baseURL: new URL(page.url()).origin });
      const p = await ctx.newPage();
      await p.goto(url);
      await expect(p.getByRole('heading', { name: 'ต้อง login' })).toBeVisible();
      await ctx.close();
    });
    let other;
    await step(page, 'ผู้ใช้ที่ไม่มีสิทธิ์ในโปรเจกต์เห็นว่าไม่มีสิทธิ์', async () => {
      other = await newUserPage(browser, outsider);
      await other.page.goto(url);
      await expect(other.page.getByRole('heading', { name: 'บัญชีนี้ไม่มีสิทธิ์ดูโปรเจกต์นี้' })).toBeVisible();
    });
    await step(other.page, 'หน้าจอของผู้ใช้ที่ไม่มีสิทธิ์', async () => { await other.ctx.close(); });
    let mem;
    await step(page, 'ผู้ใช้ที่มีสิทธิ์ในโปรเจกต์เปิดรายงานได้', async () => {
      mem = await newUserPage(browser, member);
      await mem.page.goto(url);
      await expect(mem.page.getByRole('heading', { name: title, level: 1 })).toBeVisible();
    });
    await step(mem.page, 'รายงานที่ผู้ใช้ที่มีสิทธิ์เห็น', async () => { await mem.ctx.close(); });
  });

  test('ลิงก์ตั้งรหัสผ่าน: ผิด ถูก แล้วล็อกหลังผิด 5 ครั้ง', async ({ page, step, browser }) => {
    let url;
    const pw = 'customer-pass-2026';
    await step(page, 'สร้างลิงก์แบบตั้งรหัสผ่าน', async () => {
      await page.goto('/#login');
      await login(page);
      const dlg = await openReportModal(page);
      await dlg.getByRole('button', { name: 'ลิงก์แชร์' }).click();
      await dlg.getByRole('button', { name: 'ตั้งรหัสผ่าน' }).click();
      await dlg.getByRole('button', { name: 'สร้างลิงก์' }).click();
      await expect(dlg.locator('#mErr')).toHaveText('รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร');
      await dlg.getByLabel('รหัสผ่าน', { exact: true }).fill(pw);
      await dlg.getByLabel('จัดทำให้ (ลูกค้า)').fill('ลูกค้า ACME');
      await dlg.getByRole('button', { name: 'สร้างลิงก์' }).click();
      await expect(dlg.locator('#shUrl')).toHaveValue(/\/s\/shs_/);
      url = new URL(await dlg.locator('#shUrl').inputValue()).pathname;
    });
    const origin = new URL(page.url()).origin;
    const ctx = await browser.newContext({ ...LOOK, baseURL: origin });
    const cust = await ctx.newPage();
    await step(cust, 'ลูกค้าเปิดลิงก์ เห็นหน้าใส่รหัสผ่าน', async () => {
      await cust.goto(url);
      await expect(cust.getByRole('heading', { name: 'รายงานนี้ล็อกด้วยรหัสผ่าน' })).toBeVisible();
    });
    await step(cust, 'ใส่รหัสผิด', async () => {
      await cust.getByLabel('รหัสผ่าน').fill('wrong-pass-0');
      await cust.getByRole('button', { name: 'เปิดรายงาน' }).click();
      await expect(cust.locator('#pwe')).toHaveText('รหัสผ่านไม่ถูกต้อง');
    });
    await step(cust, 'ใส่รหัสถูก เห็นรายงาน', async () => {
      await cust.getByLabel('รหัสผ่าน').fill(pw);
      await cust.getByRole('button', { name: 'เปิดรายงาน' }).click();
      await expect(cust.getByRole('heading', { name: title, level: 1 })).toBeVisible();
      await expect(cust.locator('.prepared')).toHaveText('จัดทำให้ ลูกค้า ACME');
    });
    await step(cust, 'เปิดซ้ำไม่ต้องใส่รหัสอีก (ปลดล็อกแล้ว)', async () => {
      await cust.reload();
      await expect(cust.getByRole('heading', { name: title, level: 1 })).toBeVisible();
    });
    await ctx.close();
    const ctx2 = await browser.newContext({ ...LOOK, baseURL: origin });
    const atk = await ctx2.newPage();
    await step(atk, 'อีกเบราว์เซอร์ลองรหัสผิด 5 ครั้ง', async () => {
      await atk.goto(url);
      for (let i = 1; i <= 5; i++) {
        await atk.getByLabel('รหัสผ่าน').fill(`guess-pass-${i}`);
        await atk.getByRole('button', { name: 'เปิดรายงาน' }).click();
        await expect(atk.locator('#pwe')).toHaveText('รหัสผ่านไม่ถูกต้อง');
        await expect(atk.getByRole('button', { name: 'เปิดรายงาน' })).toBeEnabled();
      }
    });
    await step(atk, 'ครั้งที่ 6 ถูกล็อก แม้ใส่รหัสถูก', async () => {
      await atk.getByLabel('รหัสผ่าน').fill(pw);
      await atk.getByRole('button', { name: 'เปิดรายงาน' }).click();
      await expect(atk.locator('#pwe')).toHaveText('ใส่รหัสผิดหลายครั้งเกินไป รอ 15 นาทีแล้วลองใหม่');
    });
    await ctx2.close();
  });

  test('ลิงก์ที่ยกเลิกแล้วและลิงก์หมดอายุใช้ไม่ได้ และนับจำนวนครั้งที่เปิด', async ({ page, step, browser, admin }) => {
    const a = (await admin.post(`/api/scans/${scanId}/shares`, { mode: 'password', password: 'pass-for-revoke', options: {} })).share;
    const b = (await admin.post(`/api/scans/${scanId}/shares`, { mode: 'password', password: 'pass-for-expire', expiresInDays: 1, options: {} })).share;
    const pathA = new URL(a.url).pathname, pathB = new URL(b.url).pathname;

    await step(page, 'รายการลิงก์ในหน้าต่างรายงาน', async () => {
      await page.goto('/#login');
      await login(page);
      const dlg = await openReportModal(page);
      await dlg.getByRole('button', { name: 'ลิงก์แชร์' }).click();
      await expect(dlg.locator('.share-row').first()).toBeVisible();
    });
    await step(page, 'ยกเลิกลิงก์ (กดยืนยันสองครั้ง)', async () => {
      const dlg = page.getByRole('dialog', { name: 'รายงานสแกน #1' });
      const btn = dlg.locator(`[data-revoke="${a.id}"]`);
      await btn.click();
      await expect(btn).toContainText('กดอีกครั้งเพื่อยกเลิกลิงก์');
      await btn.click();
      await expect(page.locator('#toast')).toContainText('ยกเลิกลิงก์แล้ว');
      await expect(dlg.locator(`[data-revoke="${a.id}"]`)).toHaveCount(0);
    });
    await step(page, 'เปิดลิงก์ที่ยกเลิกแล้ว: ไม่พบลิงก์ (404)', async () => {
      await page.goto(pathA);
      await expect(page.getByRole('heading', { name: 'ไม่พบลิงก์นี้' })).toBeVisible();
      expect((await page.request.get(`/api/share/${pathA.split('/').pop()}`)).status()).toBe(404);
    });
    await step(page, 'ลิงก์ที่หมดอายุ: ลิงก์หมดอายุแล้ว (410)', async () => {
      test.skip(!ownsContainer(), 'ต้องเลื่อนเวลาหมดอายุในฐานข้อมูลของ container ที่ชุดทดสอบเปิดเอง');
      sql(`UPDATE shares SET expires_at = now() - interval '1 hour' WHERE id = ${Number(b.id)}`);
      await page.goto(pathB);
      await expect(page.getByRole('heading', { name: 'ลิงก์หมดอายุแล้ว' })).toBeVisible();
      expect((await page.request.get(`/api/share/${pathB.split('/').pop()}`)).status()).toBe(410);
    });
    await step(page, 'จำนวนครั้งที่เปิดถูกนับ', async () => {
      const shares = await admin.get(`/api/scans/${scanId}/shares`);
      const opened = shares.filter((s) => s.views > 0);
      expect(opened.length).toBeGreaterThan(0);
      await page.goto(`/#repo/${repo.id}`);
      await page.getByRole('button', { name: 'รายงาน' }).click();
      const dlg = page.getByRole('dialog', { name: 'รายงานสแกน #1' });
      await dlg.getByRole('button', { name: 'ลิงก์แชร์' }).click();
      await expect(dlg.locator('.share-list')).toContainText(/เปิดดู [1-9]\d* ครั้ง/);
      await expect(dlg.locator('.share-list')).toContainText('ยกเลิกแล้ว');
    });
  });
});
