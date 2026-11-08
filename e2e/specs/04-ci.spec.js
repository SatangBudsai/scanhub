import { test, expect, login } from '../lib/test.js';
import { projectWithRepo, standardReports, uploadReports, uploadSource, fixture } from '../lib/api.js';
import { SAMPLE_APP } from '../lib/env.js';
import { tgz, tgzWith } from '../lib/source.js';

// A new secret file: Gitleaks reports it as a new Critical finding
const NEW_SECRET = { 'config/prod.yaml': 'aws:\n  access_key_id: AKIAQX7RZ2LMT4VBNW3P\n  secret_access_key: "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"\n' };

test.describe('CI ส่งโค้ดมาสแกน', () => {
  test.setTimeout(15 * 60 * 1000);

  test('อัปโหลด source ตามโค้ดตัวอย่าง: block ได้ 422 แจ้งผลอย่างเดียวได้ 200 และเปลี่ยนได้โดยไม่แก้ pipeline', async ({ page, step, snap, admin }) => {
    const { repo, token } = await projectWithRepo(admin);
    let first;

    await step(page, 'หน้าเชื่อมต่อ CI: โค้ดตัวอย่างส่งแบบ text/plain และไม่มี fail_on', async () => {
      await page.goto('/#login');
      await login(page);
      await page.goto(`/#connect/${repo.id}`);
      await expect(page.getByRole('heading', { name: 'เชื่อมต่อ CI' })).toBeVisible();
      const snip = page.locator('#snip');
      await expect(snip).toContainText('Accept: text/plain');
      await expect(snip).toContainText('/api/v1/scan?');
      await expect(snip).not.toContainText('fail_on');
      await expect(page.getByRole('radio', { name: /Block/ })).toHaveAttribute('aria-checked', 'true');
    });

    await step(page, 'CI ส่งโค้ดครั้งแรก: เจอ Critical/High ใหม่ ได้ 422 พร้อมสรุปเป็นข้อความ', async () => {
      first = await uploadSource(token, tgz(SAMPLE_APP), { query: 'branch=main&commit=1111111aaaa&wait=1' });
      expect(first.status).toBe(422);
      expect(first.text).toContain(`ScanHub · ${repo.name} · สแกน #1`);
      expect(first.text).toContain('ผลการตรวจ: ไม่ผ่าน');
      expect(first.text).toMatch(/ดูผล: http:\/\/localhost:\d+\/#repo\/\d+\/1/);
      await page.goto(`/#repo/${repo.id}`);
      await expect(page.locator('.scanbar .ttl')).toHaveText('สแกน #1');
      await expect(page.locator('.gate-tag')).toContainText('CI: block Critical + High ใหม่');
    });

    await step(page, 'เปลี่ยนเป็นแจ้งผลอย่างเดียวที่หน้าเชื่อมต่อ CI', async () => {
      await page.goto(`/#connect/${repo.id}`);
      await page.getByRole('radio', { name: /แจ้งผลอย่างเดียว/ }).first().click();
      await expect(page.locator('#toast')).toContainText('CI: แจ้งผลอย่างเดียว');
      await expect(page.getByRole('radio', { name: /แจ้งผลอย่างเดียว/ }).first()).toHaveAttribute('aria-checked', 'true');
    });

    await step(page, 'ส่งโค้ดที่มี secret ใหม่ด้วยคำสั่งเดิม: ผ่าน 200 แต่ยังรายงานว่าเจอ', async () => {
      const r = await uploadSource(token, tgzWith(SAMPLE_APP, NEW_SECRET), { query: 'branch=main&commit=2222222bbbb&wait=1' });
      expect(r.status).toBe(200);
      expect(r.text).toContain('สแกน #2');
      expect(r.text).toContain('ผลการตรวจ: ผ่าน (report only');
      expect(r.text).toContain('โหมดรายงานอย่างเดียว');
      await page.goto(`/#repo/${repo.id}`);
      await expect(page.locator('.scanbar .ttl')).toHaveText('สแกน #2');
      await expect(page.locator('.gate-tag')).toContainText('CI: แจ้งผลอย่างเดียว');
      await snap(page, 'มีปัญหาใหม่แต่ pipeline ผ่าน');
    });

    await step(page, 'เปลี่ยนกลับเป็น block แล้วส่งโค้ดเดิมซ้ำ: ไม่มีปัญหาใหม่ ผ่าน 200', async () => {
      await page.goto(`/#connect/${repo.id}`);
      await page.getByRole('radio', { name: /Block/ }).first().click();
      await expect(page.locator('#toast')).toContainText('CI: block Critical + High ใหม่');
      const r = await uploadSource(token, tgzWith(SAMPLE_APP, NEW_SECRET), { query: 'branch=main&commit=3333333cccc&wait=1' });
      expect(r.status).toBe(200);
      expect(r.text).toContain('ใหม่ 0 · แก้แล้ว 0');
      expect(r.text).toContain('ผลการตรวจ: ผ่าน (block');
    });

    await step(page, 'หน้า repo: สแกน #3 ไม่มีปัญหาใหม่ ทุกรายการเป็นของเดิม', async () => {
      await page.goto(`/#repo/${repo.id}`);
      await expect(page.locator('.scanbar .ttl')).toHaveText('สแกน #3');
      await expect(page.locator('.nums > div').nth(1).locator('.v')).toHaveText('0');
      await page.locator('[data-view="all"]').click();
      await expect(page.locator('#fList .f-row').first()).toBeVisible();
      await expect(page.locator('#fList .st-new')).toHaveCount(0);
      const scans = await admin.get(`/api/repos/${repo.id}/scans`);
      expect(scans.map((s) => [s.num, s.status, s.newCount])).toEqual([[3, 'done', 0], [2, 'done', scans[1].newCount], [1, 'done', scans[2].newCount]]);
      expect(scans[1].newCount).toBeGreaterThan(0);
      const d = await admin.get(`/api/scans/${scans[0].id}`);
      expect(d.findings.filter((f) => f.status !== 'fixed').every((f) => f.status === 'existing')).toBe(true);
      expect(first.text).toContain('ใหม่');
    });
  });

  test('ส่งผลจาก scanner ที่รันใน CI อยู่แล้ว (/api/v1/reports)', async ({ page, step, admin }) => {
    const { repo, token } = await projectWithRepo(admin);

    await step(page, 'token ผิดถูกปฏิเสธ 401', async () => {
      const bad = await uploadReports('shr_not_a_real_token', standardReports());
      expect(bad.status).toBe(401);
    });
    await step(page, 'ส่งรายงาน Trivy, Gitleaks, Semgrep: รวมเป็นสแกนเดียว block ได้ 422', async () => {
      const r = await uploadReports(token, standardReports());
      expect(r.status).toBe(422);
      expect(r.json.status).toBe('done');
      expect(r.json.gate.failed).toBe(true);
      expect(r.json.newCount).toBeGreaterThan(0);
      expect(r.json.counts.reduce((a, b) => a + b, 0)).toBe(r.json.newCount);
    });
    await step(page, 'หน้า repo แสดงที่มา "ส่งผลจาก CI" และ scanner 3 ตัว', async () => {
      await page.goto('/#login');
      await login(page);
      await page.goto(`/#repo/${repo.id}`);
      await expect(page.locator('.scanbar')).toContainText('ส่งผลจาก CI');
      await expect(page.locator('#runBtn')).toContainText('3 scanner ทำงานสำเร็จ');
    });
    await step(page, 'ส่งซ้ำพร้อม gate=report และเพิ่ม Grype: ผ่าน 200 รายการซ้ำถูกรวม', async () => {
      const r = await uploadReports(token, [...standardReports(), { tool: 'grype', data: fixture('grype.json') }], { query: 'gate=report', commit: 'e2e0003' });
      expect(r.status).toBe(200);
      expect(r.json.gate.mode).toBe('report');
      const d = await admin.get(`/api/scans/${r.json.scanId}`);
      expect(d.findings.some((f) => f.tools.length > 1)).toBe(true);
      await page.reload();
      await expect(page.locator('.scanbar .ttl')).toHaveText('สแกน #2');
      await expect(page.locator('#runBtn')).toContainText('4 scanner ทำงานสำเร็จ');
    });
    await step(page, 'รูปแบบรายงานที่ไม่รู้จักได้ 400', async () => {
      const r = await uploadReports(token, [{ tool: 'nope', data: {} }]);
      expect(r.status).toBe(400);
    });
  });
});
