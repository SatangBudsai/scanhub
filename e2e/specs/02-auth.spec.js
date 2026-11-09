import { test, expect, login } from '../lib/test.js';
import { apiAs, projectWithRepo, standardReports, uid, uploadReports } from '../lib/api.js';
import { ADMIN } from '../lib/env.js';

test.describe('Sign in', () => {
  test('The env admin can sign in and sees the Set from env tag', async ({ page, step, admin }) => {
    await step(page, 'Open the sign-in page', async () => {
      await page.goto('/');
      await expect(page).toHaveURL(/#login/);
      await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    });
    await step(page, 'Sign in with the env username and password', async () => {
      await login(page, ADMIN.username, ADMIN.password, { expectHash: /#projects/ });
      await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible();
    });
    await step(page, 'Account menu shows ADMIN and Set from env', async () => {
      await page.getByRole('button', { name: `Account of ${ADMIN.username}` }).click();
      const menu = page.getByRole('menu', { name: 'Account' });
      await expect(menu.locator('.role-tag')).toHaveText('ADMIN');
      await expect(menu.getByText('Set from env')).toBeVisible();
      // the env admin cannot change the password from the web
      await expect(menu.getByRole('menuitem', { name: 'Change password' })).toHaveCount(0);
    });
  });

  test('A wrong password shows an error and stays on sign-in', async ({ page, step }) => {
    await step(page, 'Enter a wrong password', async () => {
      await page.goto('/#login');
      await page.getByLabel('Username').fill(ADMIN.username);
      await page.getByLabel('Password', { exact: true }).fill('wrong-password-1');
      await page.getByRole('button', { name: 'Sign in' }).click();
    });
    await step(page, 'See the wrong-password message', async () => {
      await expect(page.locator('#lerr')).toHaveText('Wrong username or password');
      await expect(page).toHaveURL(/#login/);
    });
    await step(page, 'Empty fields ask for both values', async () => {
      await page.getByLabel('Password', { exact: true }).fill('');
      await page.getByRole('button', { name: 'Sign in' }).click();
      await expect(page.locator('#lerr')).toHaveText('Enter your username and password');
    });
  });

  test('A new user must set a new password first', async ({ page, step, admin }) => {
    const username = uid('newbie');
    await admin.post('/api/users', { username, password: 'temp-pass-123', role: 'ANALYST' });

    await step(page, 'Sign in with the temporary password from the admin', async () => {
      await page.goto('/#login');
      await login(page, username, 'temp-pass-123', { expectHash: /#password/ });
      await expect(page.getByRole('heading', { name: 'Set a new password' })).toBeVisible();
    });
    await step(page, 'Other pages are blocked until the password is changed', async () => {
      await page.evaluate(() => { location.hash = '#projects'; });
      await expect(page).toHaveURL(/#password/);
    });
    await step(page, 'The two new passwords do not match', async () => {
      await page.getByLabel('Temporary password').fill('temp-pass-123');
      await page.getByLabel('New password', { exact: true }).fill('brand-new-pass-1');
      await page.getByLabel('Confirm new password').fill('brand-new-pass-2');
      await page.getByRole('button', { name: 'Save password' }).click();
      await expect(page.locator('#perr')).toHaveText('The new passwords do not match');
    });
    await step(page, 'Wrong temporary password: error shown, still signed in', async () => {
      await page.getByLabel('Temporary password').fill('not-the-temp-1');
      await page.getByLabel('Confirm new password').fill('brand-new-pass-1');
      await page.getByRole('button', { name: 'Save password' }).click();
      await expect(page.locator('#perr')).toHaveText('Current password is wrong');
      await expect(page).toHaveURL(/#password/);
    });
    await step(page, 'Password saved: the Projects page opens', async () => {
      await page.getByLabel('Temporary password').fill('temp-pass-123');
      await page.getByRole('button', { name: 'Save password' }).click();
      await expect(page).toHaveURL(/#projects/);
      await expect(page.getByRole('heading', { name: 'No projects you can see yet' })).toBeVisible();
    });
    await step(page, 'Sign in again with the new password', async () => {
      const again = await apiAs(username, 'brand-new-pass-1');
      const me = await again.get('/api/auth/me');
      expect(me.user.mustChange).toBe(false);
      await again.dispose();
    });
  });

  test('Sign out from the account menu', async ({ page, step }) => {
    await step(page, 'Sign in and open the account menu', async () => {
      await page.goto('/#login');
      await login(page);
      await page.getByRole('button', { name: `Account of ${ADMIN.username}` }).click();
      await expect(page.getByRole('menu', { name: 'Account' })).toBeVisible();
    });
    await step(page, 'Click Sign out', async () => {
      await page.getByRole('menuitem', { name: 'Sign out' }).click();
      await expect(page).toHaveURL(/#login/);
    });
    await step(page, 'Opening Projects directly goes back to sign-in', async () => {
      await page.goto('/#projects');
      await expect(page).toHaveURL(/#login/);
      const res = await page.request.get('/api/projects');
      expect(res.status()).toBe(401);
    });
  });

  test('An expired session returns to sign-in', async ({ page, step, context }) => {
    await step(page, 'Sign in and land on Projects', async () => {
      await page.goto('/#login');
      await login(page, undefined, undefined, { expectHash: /#projects/ });
    });
    await step(page, 'The session is gone (e.g. expired)', async () => {
      await context.clearCookies();
    });
    await step(page, 'Click Settings: back to sign-in', async () => {
      await page.getByRole('link', { name: 'Settings', exact: true }).click();
      await expect(page).toHaveURL(/#login/);
      await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    });
  });

  test('Sign in from a report link returns to the report (next=)', async ({ page, step, admin }) => {
    const { repo, token } = await projectWithRepo(admin);
    const up = await uploadReports(token, standardReports(), { query: 'gate=report' });
    expect(up.status).toBe(200);
    const share = (await admin.post(`/api/scans/${up.json.scanId}/shares`, { mode: 'internal', options: { title: `Report ${repo.name}` } })).share;
    const path = new URL(share.url).pathname;

    await step(page, 'Open a share link while signed out', async () => {
      await page.goto(path);
      await expect(page.getByRole('heading', { name: 'Sign-in required' })).toBeVisible();
    });
    await step(page, 'Click Sign in: sign-in page with next', async () => {
      await page.getByRole('link', { name: 'Sign in' }).click();
      await expect(page).toHaveURL(/#login\?next=/);
    });
    await step(page, 'Sign in and return to the same report', async () => {
      await page.getByLabel('Username').fill(ADMIN.username);
      await page.getByLabel('Password', { exact: true }).fill(ADMIN.password);
      await page.getByRole('button', { name: 'Sign in' }).click();
      await expect(page).toHaveURL(new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'));
      await expect(page.getByRole('heading', { name: `Report ${repo.name}` })).toBeVisible();
    });
    await step(page, 'A next pointing off-site is ignored', async () => {
      await page.goto('/#login?next=//evil.example/x');
      await expect(page).toHaveURL(/#projects/);
    });
  });
});
