import { test, expect, login, newUserPage } from '../lib/test.js';
import { makeUser } from '../lib/api.js';
import { ADMIN } from '../lib/env.js';

const theme = (page) => page.evaluate(() => document.documentElement.getAttribute('data-theme'));
const bg = (page) => page.evaluate(() => getComputedStyle(document.body).backgroundColor);

test.describe('Account menu', () => {
  test('Switch theme Light / Dark / System and keep it after reload', async ({ page, step }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    const menuBtn = () => page.getByRole('button', { name: `Account of ${ADMIN.username}` });

    await step(page, 'Open the account menu', async () => {
      await page.goto('/#login');
      await login(page);
      await menuBtn().click();
      await expect(page.getByRole('menu', { name: 'Account' })).toBeVisible();
      await expect(page.getByRole('menuitemradio', { name: 'System' })).toHaveAttribute('aria-checked', 'true');
    });
    await step(page, 'Choose Dark', async () => {
      await page.getByRole('menuitemradio', { name: 'Dark' }).click();
      expect(await theme(page)).toBe('dark');
      expect(await bg(page)).toBe('rgb(20, 20, 21)');
    });
    await step(page, 'Reload: still dark', async () => {
      await page.reload();
      await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible();
      expect(await theme(page)).toBe('dark');
    });
    await step(page, 'Choose Light', async () => {
      await menuBtn().click();
      await page.getByRole('menuitemradio', { name: 'Light' }).click();
      expect(await theme(page)).toBe('light');
      expect(await bg(page)).toBe('rgb(250, 250, 250)');
    });
    await step(page, 'System: follows the OS setting', async () => {
      await page.getByRole('menuitemradio', { name: 'System' }).click();
      expect(await theme(page)).toBeNull();
      await page.emulateMedia({ colorScheme: 'dark' });
      await expect.poll(() => bg(page)).toBe('rgb(20, 20, 21)');
      await page.emulateMedia({ colorScheme: 'light' });
      await expect.poll(() => bg(page)).toBe('rgb(250, 250, 250)');
      await page.reload();
      expect(await theme(page)).toBeNull();
    });
  });

  test('Keyboard: arrows move, Esc closes and refocuses the button', async ({ page, step }) => {
    const btn = () => page.getByRole('button', { name: `Account of ${ADMIN.username}` });
    await step(page, 'Arrow Down on the account button opens the menu', async () => {
      await page.goto('/#login');
      await login(page);
      await btn().focus();
      await page.keyboard.press('ArrowDown');
      await expect(page.getByRole('menu', { name: 'Account' })).toBeVisible();
      await expect(page.locator('#mePop :focus')).toHaveCount(1);
    });
    await step(page, 'Arrow Right moves along the theme switch', async () => {
      await page.getByRole('menuitemradio', { name: 'Light' }).focus();
      await page.keyboard.press('ArrowRight');
      await expect(page.getByRole('menuitemradio', { name: 'Dark' })).toBeFocused();
      expect(await theme(page)).toBe('dark');
    });
    await step(page, 'Esc closes the menu and refocuses the button', async () => {
      await page.keyboard.press('Escape');
      await expect(page.getByRole('menu', { name: 'Account' })).toBeHidden();
      await expect(btn()).toBeFocused();
      await expect(btn()).toHaveAttribute('aria-expanded', 'false');
    });
    await step(page, 'Clicking outside closes it', async () => {
      await btn().click();
      await expect(page.getByRole('menu', { name: 'Account' })).toBeVisible();
      await page.locator('main').click({ position: { x: 5, y: 5 } });
      await expect(page.getByRole('menu', { name: 'Account' })).toBeHidden();
      await page.evaluate(() => localStorage.removeItem('scanhub.theme'));
    });
  });

  test('Change password only for users not set from env', async ({ page, step, browser, admin }) => {
    const user = await makeUser(admin, { role: 'ANALYST' });
    await step(page, 'Env admin has no Change password item', async () => {
      await page.goto('/#login');
      await login(page);
      await page.getByRole('button', { name: `Account of ${ADMIN.username}` }).click();
      await expect(page.getByRole('menuitem', { name: 'Change password' })).toHaveCount(0);
      await page.evaluate(() => { location.hash = '#password'; });
      await expect(page).toHaveURL(/#projects/);
    });
    const u = await newUserPage(browser, user);
    await step(u.page, 'Regular user sees Change password', async () => {
      await u.page.getByRole('button', { name: `Account of ${user.username}` }).click();
      const m = u.page.getByRole('menu', { name: 'Account' });
      await expect(m.locator('.role-tag')).toHaveText('ANALYST');
      await expect(m.getByText('Set from env')).toHaveCount(0);
      await m.getByRole('menuitem', { name: 'Change password' }).click();
      await expect(u.page.getByRole('heading', { name: 'Change password' })).toBeVisible();
    });
    await step(u.page, 'Change the password', async () => {
      await u.page.getByLabel('Current password').fill(user.password);
      await u.page.getByLabel('New password', { exact: true }).fill('changed-pass-999');
      await u.page.getByLabel('Confirm new password').fill('changed-pass-999');
      await u.page.getByRole('button', { name: 'Save password' }).click();
      await expect(u.page.locator('#toast')).toContainText('Password changed');
      await expect(u.page).toHaveURL(/#projects/);
    });
    await u.ctx.close();
  });
});
