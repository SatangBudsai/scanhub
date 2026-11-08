import { test, expect, login, newUserPage } from '../lib/test.js';
import { adminApi, apiAs, createProject, createRepo, ensureSetup, makeUser, standardReports, uid, uploadReports } from '../lib/api.js';
import { ADMIN } from '../lib/env.js';

const row = (page, username) => page.locator('.users-table tbody tr', { hasText: username });

test.describe.serial('ผู้ใช้ กลุ่ม และสิทธิ์', () => {
  let P, Q, repoP;

  test.beforeAll(async () => {
    const api = await adminApi();
    await ensureSetup(api);
    P = await createProject(api, uid('Team P'));
    Q = await createProject(api, uid('Team Q'));
    const r = await createRepo(api, P.id);
    repoP = r.repo;
    const up = await uploadReports(r.token, standardReports(), { query: 'gate=report' });
    expect(up.status).toBe(200);
    await createRepo(api, Q.id);
    await api.dispose();
  });

  test('admin เพิ่มผู้ใช้ทุก role จากหน้าผู้ใช้ และแถว admin จาก env ถูกล็อก', async ({ page, step, admin }) => {
    const names = Object.fromEntries(['ADMIN', 'SA', 'QA', 'DEVELOPER'].map((r) => [r, uid(r.toLowerCase())]));

    await step(page, 'เปิดหน้าผู้ใช้ แถว admin ตั้งค่าจาก env แก้ไม่ได้', async () => {
      await page.goto('/#login');
      await login(page);
      await page.getByRole('link', { name: 'ผู้ใช้', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'ผู้ใช้', exact: true })).toBeVisible();
      const r = row(page, ADMIN.username).filter({ hasText: 'ตั้งค่าจาก env' });
      await expect(r).toHaveCount(1);
      await expect(r.getByRole('combobox')).toBeDisabled();
      await expect(r.getByText('ทุกโปรเจกต์ (ADMIN)')).toBeVisible();
      await expect(r.getByRole('button', { name: /รีเซ็ตรหัสผ่าน|ปิดใช้งาน/ })).toHaveCount(0);
    });
    await step(page, 'รหัสชั่วคราวสั้นเกินไปถูกปฏิเสธ', async () => {
      await page.getByLabel('ชื่อผู้ใช้').fill(names.QA);
      await page.getByLabel('รหัสผ่านชั่วคราว').fill('short');
      await page.getByRole('button', { name: 'เพิ่มผู้ใช้' }).click();
      await expect(page.locator('#uerr')).toHaveText('รหัสผ่านชั่วคราวต้องมีอย่างน้อย 8 ตัวอักษร');
    });
    for (const role of ['SA', 'QA', 'DEVELOPER']) {
      await step(page, `เพิ่มผู้ใช้ ${role} แล้วเลือกโปรเจกต์ที่เห็นทันที`, async () => {
        await page.getByLabel('ชื่อผู้ใช้').fill(names[role]);
        await page.getByLabel('รหัสผ่านชั่วคราว').fill('temp-pass-123');
        await page.getByLabel('Role', { exact: true }).selectOption(role);
        await page.getByRole('button', { name: 'เพิ่มผู้ใช้' }).click();
        const dlg = page.getByRole('dialog', { name: `เลือกโปรเจกต์ที่ ${names[role]} เห็น` });
        await expect(dlg).toBeVisible();
        await dlg.locator(`[data-pc="${P.id}"]`).click();
        await dlg.getByRole('button', { name: 'บันทึก', exact: true }).click();
        await expect(dlg).toBeHidden();
        const r = row(page, names[role]);
        await expect(r).toContainText('รอเปลี่ยนรหัสผ่านชั่วคราว');
        await expect(r.getByRole('combobox')).toHaveValue(role);
        await expect(r.locator('.access-btn')).toContainText('1 โปรเจกต์');
      });
    }
    await step(page, 'เพิ่มผู้ใช้ ADMIN (เห็นทุกโปรเจกต์โดยไม่ต้องเลือก)', async () => {
      await page.getByLabel('ชื่อผู้ใช้').fill(names.ADMIN);
      await page.getByLabel('รหัสผ่านชั่วคราว').fill('temp-pass-123');
      await page.getByLabel('Role', { exact: true }).selectOption('ADMIN');
      await page.getByRole('button', { name: 'เพิ่มผู้ใช้' }).click();
      await expect(row(page, names.ADMIN)).toContainText('ทุกโปรเจกต์ (ADMIN)');
      await expect(page.getByRole('dialog')).toHaveCount(0);
    });
    await step(page, 'เปลี่ยน role ของ DEVELOPER เป็น QA แล้วกลับ', async () => {
      const sel = row(page, names.DEVELOPER).getByRole('combobox');
      await sel.selectOption('QA');
      await expect(page.locator('#toast')).toContainText(`เปลี่ยน role ของ ${names.DEVELOPER} เป็น QA แล้ว`);
      await row(page, names.DEVELOPER).getByRole('combobox').selectOption('DEVELOPER');
      await expect(row(page, names.DEVELOPER).getByRole('combobox')).toHaveValue('DEVELOPER');
    });
    await step(page, 'server มีผู้ใช้ครบทุก role', async () => {
      const users = await admin.get('/api/users');
      for (const [role, n] of Object.entries(names)) expect(users.find((u) => u.username === n)?.role).toBe(role);
    });
    await step(page, 'ตาราง "สิทธิ์ของแต่ละ role" เปิดดูได้', async () => {
      await page.getByText('สิทธิ์ของแต่ละ role').click();
      await expect(page.locator('details.perm table')).toContainText('จัดการผู้ใช้ กลุ่ม และสิทธิ์โปรเจกต์');
    });
  });

  test('แต่ละ role เห็นปุ่มและเมนูต่างกัน', async ({ page, step, browser, admin }) => {
    const dev = await makeUser(admin, { role: 'DEVELOPER', projectIds: [P.id] });
    const qa = await makeUser(admin, { role: 'QA', projectIds: [P.id] });
    const sa = await makeUser(admin, { role: 'SA', projectIds: [P.id] });

    const d = await newUserPage(browser, dev);
    await step(d.page, 'DEVELOPER: ไม่มีปุ่มสแกน ไม่มีเมนูตั้งค่าและผู้ใช้', async () => {
      await d.page.goto(`/#repo/${repoP.id}`);
      await expect(d.page.locator('.scanbar')).toBeVisible();
      await expect(d.page.locator('#scanNow')).toHaveCount(0);
      await expect(d.page.getByRole('button', { name: 'ตัวเลือกเพิ่มเติม' })).toHaveCount(0);
      await expect(d.page.getByRole('link', { name: 'ตั้งค่า', exact: true })).toHaveCount(0);
      await expect(d.page.getByRole('link', { name: 'ผู้ใช้', exact: true })).toHaveCount(0);
      await d.page.evaluate(() => { location.hash = '#settings'; });
      await expect(d.page).toHaveURL(/#projects/);
    });
    await d.ctx.close();

    const q = await newUserPage(browser, qa);
    await step(q.page, 'QA: เพิ่ม repo ไม่ได้ แต่สั่งสแกนและแชร์ได้', async () => {
      await expect(q.page.getByRole('heading', { name: P.name, exact: true })).toBeVisible();
      await expect(q.page.locator('#newRepo')).toHaveCount(0);
      await expect(q.page.locator('#newProj')).toHaveCount(0);
      await q.page.goto(`/#repo/${repoP.id}`);
      await expect(q.page.locator('#scanNow')).toBeVisible();
      await expect(q.page.getByRole('button', { name: 'ตัวเลือกเพิ่มเติม' })).toHaveCount(0);
      await q.page.getByRole('button', { name: 'รายงาน' }).click();
      await expect(q.page.getByRole('button', { name: 'ลิงก์แชร์' })).toBeVisible();
      const res = await q.page.request.post('/api/repos', { data: { projectId: P.id, name: uid('nope'), lang: 'Go', branch: 'main' } });
      expect(res.status()).toBe(403);
    });
    await q.ctx.close();

    const s = await newUserPage(browser, sa);
    await step(s.page, 'SA: เห็นหน้าตั้งค่าแบบดูอย่างเดียว ไม่เห็นหน้าผู้ใช้', async () => {
      await expect(s.page.getByRole('link', { name: 'ตั้งค่า', exact: true })).toBeVisible();
      await expect(s.page.getByRole('link', { name: 'ผู้ใช้', exact: true })).toHaveCount(0);
      await s.page.getByRole('link', { name: 'ตั้งค่า', exact: true }).click();
      await expect(s.page.getByText('ดูได้อย่างเดียว เฉพาะ ADMIN แก้ไขการตั้งค่าได้')).toBeVisible();
      await expect(s.page.getByRole('switch', { name: 'อัปเดตทุกวัน' })).toBeDisabled();
      await expect(s.page.locator('#saveGen')).toHaveCount(0);
      await expect(s.page.locator('[data-ttog]').first()).toBeDisabled();
    });
    await step(s.page, 'SA: เพิ่ม repo ได้', async () => {
      await s.page.getByRole('link', { name: 'โปรเจกต์', exact: true }).click();
      await expect(s.page.locator('#newRepo')).toBeEnabled();
    });
    await s.ctx.close();
  });

  test('ให้สิทธิ์ผ่านกลุ่ม รายคน และเห็นทุกโปรเจกต์ แล้วดูว่าใครเห็นโปรเจกต์', async ({ page, step, browser, admin }) => {
    const viaGroup = await makeUser(admin, { role: 'QA', prefix: 'grp' });
    const direct = await makeUser(admin, { role: 'QA', prefix: 'direct' });
    const everyone = await makeUser(admin, { role: 'QA', prefix: 'all' });
    const gname = uid('ทีม QA');

    await step(page, 'ผู้ใช้ใหม่ยังไม่มีสิทธิ์', async () => {
      await page.goto('/#login');
      await login(page);
      await page.goto('/#users');
      await expect(row(page, viaGroup.username).locator('.access-btn')).toContainText('ยังไม่มีสิทธิ์');
    });
    await step(page, 'สร้างกลุ่มที่มีสมาชิกและโปรเจกต์ P', async () => {
      await page.getByRole('tab', { name: /กลุ่ม/ }).click();
      await page.locator('#newGroup, #newGroup2').first().click();
      const dlg = page.getByRole('dialog', { name: 'สร้างกลุ่ม' });
      await dlg.getByLabel('ชื่อกลุ่ม').fill(gname);
      await dlg.locator('.tchip', { hasText: viaGroup.username }).click();
      await dlg.locator(`[data-pc="${P.id}"]`).click();
      await dlg.getByRole('button', { name: 'สร้างกลุ่ม' }).click();
      const g = page.locator('.grp-row', { hasText: gname });
      await expect(g).toContainText('1 สมาชิก');
      await expect(g).toContainText(P.name);
    });
    await step(page, 'ให้สิทธิ์โปรเจกต์ P กับผู้ใช้โดยตรง', async () => {
      await page.getByRole('tab', { name: /ผู้ใช้/ }).click();
      await row(page, direct.username).locator('.access-btn').click();
      const dlg = page.getByRole('dialog', { name: `สิทธิ์โปรเจกต์ของ ${direct.username}` });
      await dlg.locator(`[data-pc="${P.id}"]`).click();
      await dlg.getByRole('button', { name: 'บันทึก', exact: true }).click();
      await expect(row(page, direct.username).locator('.access-btn')).toContainText('1 โปรเจกต์');
    });
    await step(page, 'เปิด "เห็นทุกโปรเจกต์" ให้อีกคน', async () => {
      await row(page, everyone.username).locator('.access-btn').click();
      const dlg = page.getByRole('dialog', { name: `สิทธิ์โปรเจกต์ของ ${everyone.username}` });
      await dlg.getByRole('switch', { name: 'เห็นทุกโปรเจกต์' }).click();
      await dlg.getByRole('button', { name: 'บันทึก', exact: true }).click();
      await expect(row(page, everyone.username).locator('.access-btn')).toContainText('ทุกโปรเจกต์');
    });
    await step(page, 'เมนูโปรเจกต์ "ใครเห็นโปรเจกต์นี้" แสดงทั้งสามคนพร้อมที่มา', async () => {
      await page.getByRole('link', { name: 'โปรเจกต์', exact: true }).click();
      await page.getByRole('button', { name: `ตัวเลือกของ ${P.name}` }).click();
      await page.getByRole('button', { name: 'ใครเห็นโปรเจกต์นี้' }).click();
      const dlg = page.getByRole('dialog', { name: `ใครเห็น ${P.name}` });
      await expect(dlg.locator('.acc-row', { hasText: viaGroup.username })).toContainText(`กลุ่ม ${gname}`);
      await expect(dlg.locator('.acc-row', { hasText: direct.username })).toContainText('ให้สิทธิ์โดยตรง');
      await expect(dlg.locator('.acc-row', { hasText: everyone.username })).toContainText('เห็นทุกโปรเจกต์');
      await expect(dlg).toContainText(gname);
    });
    for (const [u, label, seesQ] of [[viaGroup, 'ผ่านกลุ่ม', false], [direct, 'โดยตรง', false], [everyone, 'ทุกโปรเจกต์', true]]) {
      const s = await newUserPage(browser, u);
      await step(s.page, `ผู้ใช้ที่ได้สิทธิ์${label} เห็น P${seesQ ? ' และ Q' : ' เท่านั้น'}`, async () => {
        await expect(s.page.getByRole('heading', { name: P.name, exact: true })).toBeVisible();
        await expect(s.page.getByRole('heading', { name: Q.name, exact: true })).toHaveCount(seesQ ? 1 : 0);
        if (!seesQ) {
          const res = await s.page.request.get(`/api/projects/${Q.id}/access`);
          expect([403, 404]).toContain(res.status());
          const repos = (await (await s.page.request.get('/api/projects')).json()).map((p) => p.id);
          expect(repos).not.toContain(Q.id);
        }
      });
      await s.ctx.close();
    }
  });

  test('ปิดใช้งานผู้ใช้แล้ว session จบทันที และรีเซ็ตรหัสผ่าน', async ({ page, step, browser, admin }) => {
    const victim = await makeUser(admin, { role: 'QA', prefix: 'off', projectIds: [P.id] });
    const forgot = await makeUser(admin, { role: 'QA', prefix: 'reset', projectIds: [P.id] });
    const v = await newUserPage(browser, victim);

    await step(v.page, 'ผู้ใช้กำลังใช้งานอยู่', async () => {
      await expect(v.page.getByRole('heading', { name: P.name, exact: true })).toBeVisible();
    });
    await step(page, 'admin ปิดใช้งานผู้ใช้ (ยืนยันก่อน)', async () => {
      await page.goto('/#login');
      await login(page);
      await page.goto('/#users');
      await row(page, victim.username).getByRole('button', { name: 'ปิดใช้งาน' }).click();
      const dlg = page.getByRole('dialog', { name: 'ปิดใช้งานผู้ใช้' });
      await expect(dlg).toContainText(victim.username);
      await dlg.getByRole('button', { name: 'ปิดใช้งาน' }).click();
      await expect(row(page, victim.username).locator('.pill')).toHaveText('ปิดใช้งาน');
    });
    await step(v.page, 'ผู้ใช้ที่ถูกปิดถูกพากลับไปหน้า login ทันทีที่กดอะไร', async () => {
      await v.page.locator('.repo-row').first().click();
      await expect(v.page).toHaveURL(/#login/);
    });
    await step(v.page, 'login อีกครั้งไม่ได้', async () => {
      await v.page.getByLabel('ชื่อผู้ใช้').fill(victim.username);
      await v.page.getByLabel('รหัสผ่าน', { exact: true }).fill(victim.password);
      await v.page.getByRole('button', { name: 'เข้าสู่ระบบ' }).click();
      await expect(v.page.locator('#lerr')).toHaveText('บัญชีนี้ถูกปิดใช้งาน ติดต่อ admin');
    });
    await v.ctx.close();
    await step(page, 'เปิดใช้งานกลับได้', async () => {
      await row(page, victim.username).getByRole('button', { name: 'เปิดใช้งาน' }).click();
      await expect(row(page, victim.username).locator('.pill')).toHaveText('ใช้งาน');
      const a = await apiAs(victim.username, victim.password);
      await a.dispose();
    });

    const f = await newUserPage(browser, forgot);
    await step(page, 'admin รีเซ็ตรหัสผ่านให้อีกคน', async () => {
      await row(page, forgot.username).getByRole('button', { name: 'รีเซ็ตรหัสผ่าน' }).click();
      const dlg = page.getByRole('dialog', { name: 'รีเซ็ตรหัสผ่าน' });
      await dlg.getByLabel('รหัสผ่านชั่วคราว').fill('fresh-temp-789');
      await dlg.getByRole('button', { name: 'รีเซ็ตรหัสผ่าน' }).click();
      await expect(row(page, forgot.username)).toContainText('รอเปลี่ยนรหัสผ่านชั่วคราว');
    });
    await step(f.page, 'session เดิมของผู้ใช้จบ และต้องใช้รหัสชั่วคราวใหม่', async () => {
      await f.page.reload();
      await expect(f.page).toHaveURL(/#login/);
      await login(f.page, forgot.username, 'fresh-temp-789', { expectHash: /#password/ });
      await expect(f.page.getByRole('heading', { name: 'ตั้งรหัสผ่านใหม่' })).toBeVisible();
    });
    await f.ctx.close();
  });
});
