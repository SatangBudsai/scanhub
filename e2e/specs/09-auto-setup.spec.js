import { test, expect, login } from '../lib/test.js';
import { fakeGitReset, fakeGitState, projectWithRepo, uid, uploadReports, fixture } from '../lib/api.js';
import { fakeGitFromApp, fakeGitHost } from '../lib/env.js';
import { openSealedBox } from '../../server/git/sealedbox.js';

test.describe.serial('ตั้งค่า CI อัตโนมัติในคลิกเดียว', () => {
  let gh, gl;

  test.beforeAll(async () => {
    await fakeGitReset(fakeGitHost());
  });

  async function connections(admin) {
    gh ||= await admin.post('/api/integrations', { type: 'github', name: uid('GitHub จำลอง'), baseUrl: `${fakeGitFromApp()}/gh`, token: 'ghp_e2e_fake' });
    gl ||= await admin.post('/api/integrations', { type: 'gitlab', name: uid('GitLab จำลอง'), baseUrl: `${fakeGitFromApp()}/gl`, token: 'glpat-e2e-fake' });
  }

  test('GitHub: ใส่ secret และ workflow แล้วเปิด Pull Request', async ({ page, step, snap, admin }) => {
    await connections(admin);
    const { repo } = await projectWithRepo(admin);
    const settings = await admin.get('/api/settings');

    await step(page, 'หน้าเชื่อมต่อ CI มีการ์ดตั้งค่าอัตโนมัติ', async () => {
      await page.goto('/#login');
      await login(page);
      await page.goto(`/#connect/${repo.id}`);
      await expect(page.getByRole('heading', { name: 'ตั้งค่าอัตโนมัติ' })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'หรือตั้งค่าเอง' })).toBeVisible();
    });
    await step(page, 'เลือกการเชื่อมต่อ GitHub แล้วเลือก repo acme/payment-api', async () => {
      await page.locator('#autoConn').selectOption(String(gh.id));
      const item = page.locator('#autoList .picker-item', { hasText: 'acme/payment-api' });
      await expect(item).toBeVisible();
      await item.click();
      await expect(page.locator('#autoPick .picker-sel')).toContainText('acme/payment-api');
      await expect(page.locator('#autoGo')).toBeEnabled();
    });
    await step(page, 'เลือกให้ pipeline แจ้งผลอย่างเดียว และเปิด Pull Request', async () => {
      await page.locator('.auto-card [data-gmode="report"]').click();
      await expect(page.locator('#toast')).toContainText('CI: แจ้งผลอย่างเดียว');
      await expect(page.locator('.auto-card [data-gmode="report"]')).toHaveAttribute('aria-checked', 'true');
      await expect(page.locator('#autoPick .picker-sel')).toContainText('acme/payment-api');
      await expect(page.locator('[data-amode="pr"]')).toHaveClass(/on/);
    });
    await step(page, 'กดตั้งค่าให้อัตโนมัติ ทุกขั้นสำเร็จ', async () => {
      await page.locator('#autoGo').click();
      await expect(page.locator('#toast')).toContainText('ตั้งค่าเสร็จแล้ว', { timeout: 60_000 });
      await expect(page.locator('.auto-steps .auto-step')).toHaveCount(5);
      await expect(page.locator('.auto-steps svg.lucide-check')).toHaveCount(5);
      await expect(page.locator('.auto-steps .neg')).toHaveCount(0);
      const pr = page.getByRole('link', { name: 'เปิด Pull Request' });
      await expect(pr).toHaveAttribute('href', 'https://github.test/acme/payment-api/pull/7');
      await snap(page, 'ลิงก์ Pull Request');
    });
    await step(page, 'GitHub ได้ secret ที่ถอดรหัสแล้วเป็น token ที่ใช้ได้จริง', async () => {
      const st = await fakeGitState(fakeGitHost());
      const sec = st.gh.secrets.SCANHUB_TOKEN;
      expect(sec.key_id).toBe('kid-1');
      const token = openSealedBox(sec.encrypted_value, st.keys.publicKey, st.keys.secretKey);
      expect(token).toMatch(/^shr_/);
      const r = await uploadReports(token, [{ tool: 'trivy', data: fixture('trivy.json') }]);
      expect(r.status).toBe(200); // report mode: never blocks
      expect(st.gh.variables.SCANHUB_URL).toBe(settings.serverUrl);
    });
    await step(page, 'workflow ถูกเพิ่มใน branch scanhub/setup ส่ง text/plain และไม่มี fail_on', async () => {
      const st = await fakeGitState(fakeGitHost());
      const wf = st.gh.files['scanhub/setup']['.github/workflows/scanhub.yml'].content;
      expect(wf).toContain('/api/v1/scan?');
      expect(wf).toContain('Accept: text/plain');
      expect(wf).toContain('secrets.SCANHUB_TOKEN');
      expect(wf).not.toContain('fail_on');
      expect(st.gh.pulls).toHaveLength(1);
      expect(st.gh.pulls[0].head).toBe('scanhub/setup');
    });
    await step(page, 'repo ถูกผูกกับ remote และใช้ gate แจ้งผลอย่างเดียว', async () => {
      await page.reload();
      await expect(page.locator('.auto-linked')).toContainText('ผูกกับ acme/payment-api');
      const r = await admin.get(`/api/repos/${repo.id}`);
      expect(r.remote).toMatchObject({ fullName: 'acme/payment-api' });
      expect(r.gate.mode).toBe('report');
    });
  });

  test('GitLab: ใส่ variable และไฟล์ pipeline แล้วเปิด Merge Request', async ({ page, step, admin }) => {
    await connections(admin);
    const { repo } = await projectWithRepo(admin);

    await step(page, 'เลือกการเชื่อมต่อ GitLab และ repo grp/app', async () => {
      await page.goto('/#login');
      await login(page);
      await page.goto(`/#connect/${repo.id}`);
      await page.locator('#autoConn').selectOption(String(gl.id));
      await expect(page.locator('.auto-card')).toContainText('Repo ใน GitLab');
      await page.locator('#autoList .picker-item', { hasText: 'grp/app' }).click();
      await expect(page.locator('[data-amode="pr"]')).toContainText('เปิด Merge Request');
    });
    await step(page, 'ใช้ block Critical + High ใหม่ แล้วกดตั้งค่าให้อัตโนมัติ', async () => {
      await expect(page.locator('.auto-card [data-gmode="block"]')).toHaveAttribute('aria-checked', 'true');
      await page.locator('#autoGo').click();
      await expect(page.locator('#toast')).toContainText('ตั้งค่าเสร็จแล้ว', { timeout: 60_000 });
      await expect(page.locator('.auto-steps svg.lucide-check')).toHaveCount(5);
      await expect(page.getByRole('link', { name: 'เปิด Merge Request' })).toHaveAttribute('href', 'https://gitlab.test/grp/app/-/merge_requests/3');
    });
    await step(page, 'GitLab ได้ variable แบบ masked และไฟล์ที่ include อยู่ใน .gitlab-ci.yml เดิม', async () => {
      const st = await fakeGitState(fakeGitHost());
      expect(st.gl.variables.SCANHUB_TOKEN.masked).toBe(true);
      expect(st.gl.variables.SCANHUB_TOKEN.value).toMatch(/^shr_/);
      expect(st.gl.variables.SCANHUB_URL.value).toBeTruthy();
      const files = st.gl.files['scanhub/setup'];
      const job = files['.gitlab/scanhub.yml'];
      expect(job).toContain('stage: .pre');
      expect(job).toContain('Accept: text/plain');
      expect(job).not.toContain('fail_on');
      const ci = files['.gitlab-ci.yml'];
      expect(ci).toContain('.gitlab/scanhub.yml');
      expect(ci).toContain('build:');
      expect(st.gl.mrs).toHaveLength(1);
      expect(st.gl.mrs[0].source_branch).toBe('scanhub/setup');
    });
    await step(page, 'ตั้งค่าใหม่อีกครั้งได้ โดย include ไม่ถูกเพิ่มซ้ำ', async () => {
      await page.reload();
      await page.getByRole('button', { name: 'ตั้งค่าใหม่' }).click();
      await expect(page.locator('#autoGo')).toBeVisible();
      await page.locator('#autoGo').click();
      await expect(page.locator('#toast')).toContainText('ตั้งค่าเสร็จแล้ว', { timeout: 60_000 });
      const st = await fakeGitState(fakeGitHost());
      const ci = st.gl.files['scanhub/setup']['.gitlab-ci.yml'];
      expect(ci.split('.gitlab/scanhub.yml').length - 1).toBe(1);
      expect(st.gl.mrs).toHaveLength(1);
    });
  });

  test('ยังไม่มีการเชื่อมต่อ: หน้าเชื่อมต่อ CI พาไปเพิ่มที่หน้าตั้งค่า', async ({ page, step, admin }) => {
    for (const c of [gh, gl].filter(Boolean)) await admin.del(`/api/integrations/${c.id}`);
    const { repo } = await projectWithRepo(admin);
    await step(page, 'admin เห็นปุ่มเพิ่มการเชื่อมต่อ GitHub/GitLab', async () => {
      await page.goto('/#login');
      await login(page);
      const left = await admin.get('/api/integrations');
      test.skip(left.length > 0, 'มีการเชื่อมต่ออื่นค้างอยู่');
      await page.goto(`/#connect/${repo.id}`);
      await expect(page.getByRole('link', { name: 'เพิ่มการเชื่อมต่อ GitHub/GitLab' })).toBeVisible();
    });
    await step(page, 'กดแล้วไปที่ส่วนการเชื่อมต่อ Git ในหน้าตั้งค่า', async () => {
      await page.getByRole('link', { name: 'เพิ่มการเชื่อมต่อ GitHub/GitLab' }).click();
      await expect(page).toHaveURL(/#settings/);
      await expect(page.locator('#secGit')).toBeInViewport();
    });
  });
});
