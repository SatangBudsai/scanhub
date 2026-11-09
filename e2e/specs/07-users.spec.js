import { test, expect, login, newUserPage } from '../lib/test.js';
import { adminApi, apiAs, createProject, createRepo, ensureSetup, makeUser, standardReports, uid, uploadReports } from '../lib/api.js';
import { ADMIN } from '../lib/env.js';

const row = (page, username) => page.locator('.users-table tbody tr', { hasText: username });

test.describe.serial('Users, groups and access', () => {
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

  test('Admin adds users of every role; the env admin row is locked', async ({ page, step, admin }) => {
    const names = Object.fromEntries(['ADMIN', 'MAINTAINER', 'ANALYST', 'VIEWER'].map((r) => [r, uid(r.toLowerCase())]));

    await step(page, 'Open Users: the env admin row cannot be edited', async () => {
      await page.goto('/#login');
      await login(page);
      await page.getByRole('link', { name: 'Users', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Users', exact: true })).toBeVisible();
      const r = row(page, ADMIN.username).filter({ hasText: 'Set from env' });
      await expect(r).toHaveCount(1);
      await expect(r.getByRole('combobox')).toBeDisabled();
      await expect(r.getByText('All projects (admin)')).toBeVisible();
      await expect(r.getByRole('button', { name: /Reset password|Disable/ })).toHaveCount(0);
    });
    await step(page, 'A too-short temporary password is rejected', async () => {
      await page.getByLabel('Username').fill(names.ANALYST);
      await page.getByLabel('Temporary password').fill('short');
      await page.getByRole('button', { name: 'Add user' }).click();
      await expect(page.locator('#uerr')).toHaveText('Temporary password must be at least 8 characters');
    });
    for (const role of ['MAINTAINER', 'ANALYST', 'VIEWER']) {
      await step(page, `Add a ${role} and pick their projects right away`, async () => {
        await page.getByLabel('Username').fill(names[role]);
        await page.getByLabel('Temporary password').fill('temp-pass-123');
        await page.getByLabel('Role', { exact: true }).selectOption(role);
        await page.getByRole('button', { name: 'Add user' }).click();
        const dlg = page.getByRole('dialog', { name: `Choose projects ${names[role]} can see` });
        await expect(dlg).toBeVisible();
        await dlg.locator(`[data-pc="${P.id}"]`).click();
        await dlg.getByRole('button', { name: 'Save', exact: true }).click();
        await expect(dlg).toBeHidden();
        const r = row(page, names[role]);
        await expect(r).toContainText('Must change temporary password');
        await expect(r.getByRole('combobox')).toHaveValue(role);
        await expect(r.locator('.access-btn')).toContainText('1 project');
      });
    }
    await step(page, 'Add an ADMIN (sees all projects, nothing to pick)', async () => {
      await page.getByLabel('Username').fill(names.ADMIN);
      await page.getByLabel('Temporary password').fill('temp-pass-123');
      await page.getByLabel('Role', { exact: true }).selectOption('ADMIN');
      await page.getByRole('button', { name: 'Add user' }).click();
      await expect(row(page, names.ADMIN)).toContainText('All projects (admin)');
      await expect(page.getByRole('dialog')).toHaveCount(0);
    });
    await step(page, 'Change the VIEWER to ANALYST and back', async () => {
      const sel = row(page, names.VIEWER).getByRole('combobox');
      await sel.selectOption('ANALYST');
      await expect(page.locator('#toast')).toContainText(`Changed role of ${names.VIEWER} to ANALYST`);
      await row(page, names.VIEWER).getByRole('combobox').selectOption('VIEWER');
      await expect(row(page, names.VIEWER).getByRole('combobox')).toHaveValue('VIEWER');
    });
    await step(page, 'The server has a user for every role', async () => {
      const users = await admin.get('/api/users');
      for (const [role, n] of Object.entries(names)) expect(users.find((u) => u.username === n)?.role).toBe(role);
    });
    await step(page, 'Open the "Permissions by role" table', async () => {
      await page.getByText('Permissions by role').click();
      await expect(page.locator('details.perm table')).toContainText('Manage users, groups and project access');
    });
  });

  test('Each role sees different buttons and menus', async ({ page, step, browser, admin }) => {
    const dev = await makeUser(admin, { role: 'VIEWER', projectIds: [P.id] });
    const qa = await makeUser(admin, { role: 'ANALYST', projectIds: [P.id] });
    const sa = await makeUser(admin, { role: 'MAINTAINER', projectIds: [P.id] });

    const d = await newUserPage(browser, dev);
    await step(d.page, 'VIEWER: no scan button, no Settings or Users menu', async () => {
      await d.page.goto(`/#repo/${repoP.id}`);
      await expect(d.page.locator('.scanbar')).toBeVisible();
      await expect(d.page.locator('#scanNow')).toHaveCount(0);
      await expect(d.page.getByRole('button', { name: 'More options' })).toHaveCount(0);
      await expect(d.page.getByRole('link', { name: 'Settings', exact: true })).toHaveCount(0);
      await expect(d.page.getByRole('link', { name: 'Users', exact: true })).toHaveCount(0);
      await d.page.evaluate(() => { location.hash = '#settings'; });
      await expect(d.page).toHaveURL(/#projects/);
    });
    await d.ctx.close();

    const q = await newUserPage(browser, qa);
    await step(q.page, 'ANALYST: cannot add repos, but can scan and share', async () => {
      await expect(q.page.getByRole('heading', { name: P.name, exact: true })).toBeVisible();
      await expect(q.page.locator('#newRepo')).toHaveCount(0);
      await expect(q.page.locator('#newProj')).toHaveCount(0);
      await q.page.goto(`/#repo/${repoP.id}`);
      await expect(q.page.locator('#scanNow')).toBeVisible();
      await expect(q.page.getByRole('button', { name: 'More options' })).toHaveCount(0);
      await q.page.getByRole('button', { name: 'Report' }).click();
      await expect(q.page.getByRole('button', { name: 'Share link' })).toBeVisible();
      const res = await q.page.request.post('/api/repos', { data: { projectId: P.id, name: uid('nope'), lang: 'Go', branch: 'main' } });
      expect(res.status()).toBe(403);
    });
    await q.ctx.close();

    const s = await newUserPage(browser, sa);
    await step(s.page, 'MAINTAINER: Settings is read-only, no Users page', async () => {
      await expect(s.page.getByRole('link', { name: 'Settings', exact: true })).toBeVisible();
      await expect(s.page.getByRole('link', { name: 'Users', exact: true })).toHaveCount(0);
      await s.page.getByRole('link', { name: 'Settings', exact: true }).click();
      await expect(s.page.getByText('Read only. Only ADMIN can change settings')).toBeVisible();
      await expect(s.page.getByRole('switch', { name: 'Update daily' })).toBeDisabled();
      await expect(s.page.locator('#saveGen')).toHaveCount(0);
      await expect(s.page.locator('[data-ttog]').first()).toBeDisabled();
    });
    await step(s.page, 'MAINTAINER: can add repos', async () => {
      await s.page.getByRole('link', { name: 'Projects', exact: true }).click();
      await expect(s.page.locator('#newRepo')).toBeEnabled();
    });
    await s.ctx.close();
  });

  test('Grant access by group, directly and to all projects, then check who can see a project', async ({ page, step, browser, admin }) => {
    const viaGroup = await makeUser(admin, { role: 'ANALYST', prefix: 'grp' });
    const direct = await makeUser(admin, { role: 'ANALYST', prefix: 'direct' });
    const everyone = await makeUser(admin, { role: 'ANALYST', prefix: 'all' });
    const gname = uid('QA team');

    await step(page, 'A new user has no access yet', async () => {
      await page.goto('/#login');
      await login(page);
      await page.goto('/#users');
      await expect(row(page, viaGroup.username).locator('.access-btn')).toContainText('No access yet');
    });
    await step(page, 'Create a group with a member and project P', async () => {
      await page.getByRole('tab', { name: /Groups/ }).click();
      await page.locator('#newGroup, #newGroup2').first().click();
      const dlg = page.getByRole('dialog', { name: 'New group' });
      await dlg.getByLabel('Group name').fill(gname);
      await dlg.locator('.tchip', { hasText: viaGroup.username }).click();
      await dlg.locator(`[data-pc="${P.id}"]`).click();
      await dlg.getByRole('button', { name: 'New group' }).click();
      const g = page.locator('.grp-row', { hasText: gname });
      await expect(g).toContainText('1 Member');
      await expect(g).toContainText(P.name);
    });
    await step(page, 'Grant project P to a user directly', async () => {
      await page.getByRole('tab', { name: /Users/ }).click();
      await row(page, direct.username).locator('.access-btn').click();
      const dlg = page.getByRole('dialog', { name: `Project access for ${direct.username}` });
      await dlg.locator(`[data-pc="${P.id}"]`).click();
      await dlg.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(row(page, direct.username).locator('.access-btn')).toContainText('1 project');
    });
    await step(page, 'Turn on "See all projects" for another user', async () => {
      await row(page, everyone.username).locator('.access-btn').click();
      const dlg = page.getByRole('dialog', { name: `Project access for ${everyone.username}` });
      await dlg.getByRole('switch', { name: 'See all projects' }).click();
      await dlg.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(row(page, everyone.username).locator('.access-btn')).toContainText('All projects');
    });
    await step(page, '"Who can see this project" lists all three and why', async () => {
      await page.getByRole('link', { name: 'Projects', exact: true }).click();
      await page.getByRole('button', { name: `Options for ${P.name}` }).click();
      await page.getByRole('button', { name: 'Who can see this project' }).click();
      const dlg = page.getByRole('dialog', { name: `Who can see ${P.name}` });
      await expect(dlg.locator('.acc-row', { hasText: viaGroup.username })).toContainText(`Group ${gname}`);
      await expect(dlg.locator('.acc-row', { hasText: direct.username })).toContainText('granted directly');
      await expect(dlg.locator('.acc-row', { hasText: everyone.username })).toContainText('See all projects');
      await expect(dlg).toContainText(gname);
    });
    for (const [u, label, seesQ] of [[viaGroup, 'via a group', false], [direct, 'directly', false], [everyone, 'all projects', true]]) {
      const s = await newUserPage(browser, u);
      await step(s.page, `User granted ${label} sees ${seesQ ? 'P and Q' : 'only P'}`, async () => {
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

  test('Disabling a user ends their session at once; reset password', async ({ page, step, browser, admin }) => {
    const victim = await makeUser(admin, { role: 'ANALYST', prefix: 'off', projectIds: [P.id] });
    const forgot = await makeUser(admin, { role: 'ANALYST', prefix: 'reset', projectIds: [P.id] });
    const v = await newUserPage(browser, victim);

    await step(v.page, 'The user is signed in and working', async () => {
      await expect(v.page.getByRole('heading', { name: P.name, exact: true })).toBeVisible();
    });
    await step(page, 'Admin disables the user (after confirming)', async () => {
      await page.goto('/#login');
      await login(page);
      await page.goto('/#users');
      await row(page, victim.username).getByRole('button', { name: 'Disable' }).click();
      const dlg = page.getByRole('dialog', { name: 'Disable user' });
      await expect(dlg).toContainText(victim.username);
      await dlg.getByRole('button', { name: 'Disable' }).click();
      await expect(row(page, victim.username).locator('.pill')).toHaveText('Disabled');
    });
    await step(v.page, 'The disabled user is sent to sign-in on the next click', async () => {
      await v.page.locator('.repo-row').first().click();
      await expect(v.page).toHaveURL(/#login/);
    });
    await step(v.page, 'Signing in again fails', async () => {
      await v.page.getByLabel('Username').fill(victim.username);
      await v.page.getByLabel('Password', { exact: true }).fill(victim.password);
      await v.page.getByRole('button', { name: 'Sign in' }).click();
      await expect(v.page.locator('#lerr')).toHaveText('This account is disabled. Contact an admin');
    });
    await v.ctx.close();
    await step(page, 'Enable the user again', async () => {
      await row(page, victim.username).getByRole('button', { name: 'Enable' }).click();
      await expect(row(page, victim.username).locator('.pill')).toHaveText('Active');
      const a = await apiAs(victim.username, victim.password);
      await a.dispose();
    });

    const f = await newUserPage(browser, forgot);
    await step(page, "Admin resets another user's password", async () => {
      await row(page, forgot.username).getByRole('button', { name: 'Reset password' }).click();
      const dlg = page.getByRole('dialog', { name: 'Reset password' });
      await dlg.getByLabel('Temporary password').fill('fresh-temp-789');
      await dlg.getByRole('button', { name: 'Reset password' }).click();
      await expect(row(page, forgot.username)).toContainText('Must change temporary password');
    });
    await step(f.page, 'The old session ends; the new temporary password is required', async () => {
      await f.page.reload();
      await expect(f.page).toHaveURL(/#login/);
      await login(f.page, forgot.username, 'fresh-temp-789', { expectHash: /#password/ });
      await expect(f.page.getByRole('heading', { name: 'Set a new password' })).toBeVisible();
    });
    await f.ctx.close();
  });
});
