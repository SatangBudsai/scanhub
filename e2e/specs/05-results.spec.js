import fs from 'node:fs';
import { test, expect, login } from '../lib/test.js';
import { adminApi, ensureSetup, projectWithRepo, uploadSource } from '../lib/api.js';
import { SAMPLE_APP } from '../lib/env.js';
import { tgz, tgzWith } from '../lib/source.js';

// Scan #1: the sample app. Scan #2: the SQL injection file removed (fixed) and a new secret added (new).
const EDITS = {
  'internal/repo/order.go': null,
  'config/prod.yaml': 'aws:\n  access_key_id: AKIAQX7RZ2LMT4VBNW3P\n  secret_access_key: "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"\n',
};

test.describe.serial('ผลสแกนรวมทุก scanner', () => {
  test.setTimeout(10 * 60 * 1000);
  let repo, token, scans, detail;

  test.beforeAll(async () => {
    test.setTimeout(15 * 60 * 1000);
    const api = await adminApi();
    await ensureSetup(api);
    ({ repo, token } = await projectWithRepo(api));
    const r1 = await uploadSource(token, tgz(SAMPLE_APP), { query: 'branch=main&commit=aaaa1111&wait=1&gate=report' });
    expect(r1.status).toBe(200);
    const r2 = await uploadSource(token, tgzWith(SAMPLE_APP, EDITS), { query: 'branch=main&commit=bbbb2222&wait=1&gate=report' });
    expect(r2.status).toBe(200);
    scans = await api.get(`/api/repos/${repo.id}/scans`);
    detail = await api.get(`/api/scans/${scans[0].id}`);
    await api.dispose();
  });

  test('สรุปตัวเลข ระดับความรุนแรง และมุมมองต้องดู / ทั้งหมด / แก้แล้ว', async ({ page, step }) => {
    const open = detail.findings.filter((f) => f.status !== 'fixed');
    const focus = open.filter((f) => f.status === 'new' || f.severity === 'critical' || f.severity === 'high');
    const fixed = detail.findings.filter((f) => f.status === 'fixed');

    await step(page, 'เปิดหน้า repo เห็นสแกนล่าสุด #2', async () => {
      await page.goto('/#login');
      await login(page);
      await page.goto(`/#repo/${repo.id}`);
      await expect(page.locator('.scanbar .ttl')).toHaveText('สแกน #2');
      await expect(page.locator('.scanbar')).toContainText('ล่าสุด');
    });
    await step(page, 'ตัวเลขยังเปิดอยู่ ใหม่ และแก้แล้ว ตรงกับ server', async () => {
      const v = page.locator('.nums .v');
      await expect(v.nth(0)).toHaveText(String(detail.openCount));
      await expect(v.nth(1)).toHaveText(String(detail.newCount));
      await expect(v.nth(2)).toHaveText(String(detail.fixedCount));
      expect(detail.newCount).toBeGreaterThan(0);
      expect(detail.fixedCount).toBeGreaterThan(0);
      await expect(page.locator('.sum .sevbar')).toHaveAttribute('aria-label', `Critical ${detail.counts[0]}, High ${detail.counts[1]}, Medium ${detail.counts[2]}, Low ${detail.counts[3]}, Info ${detail.counts[4]}`);
    });
    await step(page, 'มุมมองต้องดูแสดงเฉพาะปัญหาใหม่และ Critical/High', async () => {
      await expect(page.locator('[data-view="focus"]')).toHaveAttribute('aria-selected', 'true');
      await expect(page.locator('[data-view="focus"] .n')).toHaveText(String(focus.length));
      await expect(page.locator('#fList .f-row')).toHaveCount(focus.length);
    });
    await step(page, 'มุมมองทั้งหมดแสดงทุกรายการที่ยังเปิดอยู่', async () => {
      await page.locator('[data-view="all"]').click();
      await expect(page.locator('#fList .f-row')).toHaveCount(open.length);
    });
    await step(page, 'มุมมองแก้แล้วแสดงรายการที่หายไปจากสแกนก่อน', async () => {
      await page.locator('[data-view="fixed"]').click();
      await expect(page.locator('#fList .f-row')).toHaveCount(fixed.length);
      await expect(page.locator('#fList .f-st').first()).toHaveText('แก้แล้ว');
      await expect(page.locator('#fList')).toContainText('order.go');
    });
    await step(page, 'กด Critical ในแถบความรุนแรง รายการกรองเหลือ Critical อย่างเดียว', async () => {
      await page.locator('[data-sevgo="critical"]').click();
      await expect(page.locator('[data-view="all"]')).toHaveAttribute('aria-selected', 'true');
      const rows = page.locator('#fList .f-row .sev');
      await expect(rows).toHaveCount(open.filter((f) => f.severity === 'critical').length);
      for (const t of await rows.allTextContents()) expect(t.trim()).toBe('Critical');
      await expect(page.locator('#fCnt')).toHaveText(' 1');
    });
  });

  test('ค้นหา ตัวกรอง จัดกลุ่ม และรายละเอียดของปัญหาที่หลาย scanner เจอ', async ({ page, step, snap }) => {
    const open = detail.findings.filter((f) => f.status !== 'fixed');
    const merged = open.find((f) => f.tools.length > 1 && f.snippet && f.snippet.lines?.length);
    const secrets = open.filter((f) => f.category === 'Secret');

    await step(page, 'เปิดมุมมองทั้งหมดแล้วค้นหาชื่อไฟล์', async () => {
      await page.goto('/#login');
      await login(page);
      await page.goto(`/#repo/${repo.id}`);
      await page.locator('[data-view="all"]').click();
      await page.getByPlaceholder('ค้นหา').fill('prod.yaml');
      const rows = page.locator('#fList .f-row');
      await expect(rows.first()).toBeVisible();
      for (const t of await rows.locator('.f-sub .mono').allTextContents()) expect(t).toContain('prod.yaml');
    });
    await step(page, 'ค้นหาสิ่งที่ไม่มีแสดงข้อความว่าง แล้วล้างตัวกรอง', async () => {
      await page.getByPlaceholder('ค้นหา').fill('no-such-thing-xyz');
      await expect(page.locator('#fList')).toContainText('ไม่พบรายการที่ตรงกับตัวกรอง');
      await page.locator('#fClear2').click();
      await expect(page.locator('#fList .f-row')).toHaveCount(open.length);
    });
    await step(page, 'เปิดแผงตัวกรอง เลือกประเภท Secret', async () => {
      await page.locator('#fBtn').click();
      await expect(page.locator('#fPanel')).toBeVisible();
      await page.getByLabel('ประเภท').selectOption('Secret');
      await expect(page.locator('#fList .f-row')).toHaveCount(secrets.length);
      expect(secrets.length).toBeGreaterThan(0);
    });
    await step(page, 'เลือก scanner Gitleaks และจัดกลุ่มตามไฟล์', async () => {
      await page.getByLabel('ประเภท').selectOption('');
      await page.getByLabel('Scanner').selectOption('gitleaks');
      await expect(page.locator('#fList .f-row')).toHaveCount(open.filter((f) => f.tools.includes('gitleaks')).length);
      await page.locator('[data-group="file"]').click();
      await expect(page.locator('#fList .g-h').first()).toContainText('config/');
    });
    await step(page, 'จัดกลุ่มตามความรุนแรงและตาม scanner', async () => {
      await page.locator('#fClear').click();
      await page.locator('[data-group="sev"]').click();
      await expect(page.locator('#fList .g-h').first()).toContainText('Critical');
      await page.locator('[data-group="tool"]').click();
      const heads = await page.locator('#fList .g-h > span:first-child').allTextContents();
      expect(heads).toEqual(expect.arrayContaining(['Trivy', 'Gitleaks', 'Semgrep']));
      await page.locator('#fClear').click();
    });
    await step(page, `กดดูปัญหาที่ ${merged.tools.length} scanner เจอ: เห็นโค้ด จุดที่พบ และรวมเป็นรายการเดียว`, async () => {
      await page.locator('#fBtn').click();
      await page.getByPlaceholder('ค้นหา').fill(merged.location);
      const row = page.locator(`[data-tog="${merged.id}"]`);
      await row.click();
      const d = page.locator('.f.open .f-detail');
      await expect(d.locator('.code pre')).toBeVisible();
      await expect(d.locator('.code .hl')).toHaveCount(1);
      await expect(d).toContainText('รวมเป็นรายการเดียว');
      await expect(d.locator('.kv')).toContainText('พบโดย');
      await snap(page, 'รายละเอียดของปัญหา');
    });
    await step(page, 'secret ในโค้ดถูกปิดบัง ไม่แสดงค่าจริง', async () => {
      await page.getByPlaceholder('ค้นหา').fill('');
      const html = await page.locator('#fList').innerHTML();
      expect(html).not.toContain('Zk3pQ9vT2mX8rLw4Yb7nC1sD5fG6hJ0aE2uI9oKq');
    });
  });

  test('ประวัติการสแกน สลับสแกน และดาวน์โหลด CSV', async ({ page, step }) => {
    await step(page, 'เปิดประวัติการสแกนเห็น 2 ครั้ง', async () => {
      await page.goto('/#login');
      await login(page);
      await page.goto(`/#repo/${repo.id}`);
      await page.getByRole('button', { name: /ประวัติ/ }).click();
      await expect(page.locator('#histPop .hist-row')).toHaveCount(2);
    });
    await step(page, 'สลับไปสแกน #1', async () => {
      await page.locator('#histPop .hist-row', { hasText: '#1' }).click();
      await expect(page).toHaveURL(new RegExp(`#repo/${repo.id}/1$`));
      await expect(page.locator('.scanbar .ttl')).toHaveText('สแกน #1');
      await expect(page.getByRole('link', { name: 'ไปที่สแกนล่าสุด' })).toBeVisible();
      await expect(page.locator('.nums .d').first()).toHaveText('สแกนแรกของ repo');
    });
    await step(page, 'ดาวน์โหลด CSV ของรายการที่กรองอยู่', async () => {
      await page.locator('[data-view="all"]').click();
      const dl = page.waitForEvent('download');
      await page.getByRole('button', { name: 'CSV' }).click();
      const d = await dl;
      expect(d.suggestedFilename()).toBe(`${repo.name}-scan-1.csv`);
      const csv = fs.readFileSync(await d.path(), 'utf8').replace(/^﻿/, '');
      const lines = csv.trim().split(/\r\n/);
      expect(lines[0]).toBe('severity,status,category,title,location,rules,tools,first_seen_scan,fix');
      expect(lines.length - 1).toBe(scans[1].openCount);
    });
    await step(page, 'กลับไปสแกนล่าสุด', async () => {
      await page.getByRole('link', { name: 'ไปที่สแกนล่าสุด' }).click();
      await expect(page.locator('.scanbar .ttl')).toHaveText('สแกน #2');
    });
  });

  test('สถานะกำลังสแกน และสแกนล้มเหลว', async ({ page, step, admin }) => {
    await step(page, 'CI ส่งโค้ดแบบไม่รอผล ได้ 202', async () => {
      await page.goto('/#login');
      await login(page);
      const r = await uploadSource(token, tgz(SAMPLE_APP), { query: 'branch=main&commit=cccc3333', text: false });
      expect(r.status).toBe(202);
      expect(r.json.num).toBe(3);
    });
    await step(page, 'หน้า repo แสดงว่ากำลังสแกน #3', async () => {
      await page.goto(`/#repo/${repo.id}/3`);
      await expect(page.getByRole('heading', { name: /(กำลังสแกน|รอคิวสแกน) #3/ })).toBeVisible();
    });
    await step(page, 'เมื่อสแกนเสร็จ หน้าอัปเดตเองเป็นผลของสแกน #3', async () => {
      await expect(page.locator('.scanbar .ttl')).toHaveText('สแกน #3', { timeout: 300_000 });
      await expect(page.locator('.sum .nums')).toBeVisible({ timeout: 300_000 });
    });
    await step(page, 'CI ส่งไฟล์ที่ไม่ใช่ tar: สแกนล้มเหลว ได้ 500', async () => {
      const r = await uploadSource(token, Buffer.from('this is not a gzip tar archive'), { query: 'branch=main&commit=dddd4444&wait=1' });
      expect(r.status).toBe(500);
      expect(r.text).toContain('สแกนไม่สำเร็จ');
    });
    await step(page, 'หน้า repo ของสแกน #4 แสดงว่าไม่สำเร็จพร้อมสาเหตุ', async () => {
      await page.goto(`/#repo/${repo.id}/4`);
      await expect(page.getByText('สแกน #4 ไม่สำเร็จ')).toBeVisible();
      await expect(page.locator('.failhead .t2')).not.toHaveText('');
    });
    await step(page, 'หน้าโปรเจกต์บอกว่าสแกนล่าสุดล้มเหลว', async () => {
      await page.getByRole('link', { name: 'โปรเจกต์', exact: true }).click();
      const row = page.locator('.repo-row', { hasText: repo.name });
      await expect(row.locator('.status')).toHaveText('สแกนล้มเหลว');
      const scans = await admin.get(`/api/repos/${repo.id}/scans`);
      expect(scans[0]).toMatchObject({ num: 4, status: 'failed' });
    });
  });
});
