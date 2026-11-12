import { test, expect, login } from '../lib/test.js';
import { adminApi } from '../lib/api.js';
import { ADMIN } from '../lib/env.js';

test.describe('First-time setup', () => {
  test('Admin picks scanners and an auto-update time in the wizard', async ({ page, step }) => {
    const api = await adminApi();
    const before = await api.get('/api/setup');
    test.skip(before.done, 'this instance has already been set up');

    await step(page, 'Open ScanHub for the first time, sign in as the env admin', async () => {
      await page.goto('/');
      await expect(page).toHaveURL(/#login/);
      await login(page, undefined, undefined, { expectHash: /#setup/ });
      await expect(page.getByRole('heading', { name: 'Choose scanners to enable' })).toBeVisible();
    });

    await step(page, 'Scanners that need no setup are preselected, SonarQube is not', async () => {
      await expect(page.getByText('6 of 7 selected')).toBeVisible();
      await expect(page.locator('[data-pick="sonarqube"]')).toHaveAttribute('aria-pressed', 'false');
      await expect(page.locator('[data-pick="trivy"]')).toHaveAttribute('aria-pressed', 'true');
    });

    await step(page, 'Turn Checkov off and on: the counter follows', async () => {
      await page.locator('[data-pick="checkov"]').click();
      await expect(page.getByText('5 of 7 selected')).toBeVisible();
      await page.locator('[data-pick="checkov"]').click();
      await expect(page.getByText('6 of 7 selected')).toBeVisible();
    });

    await step(page, 'Semgrep asks to accept its rules license first', async () => {
      const box = page.locator('#wSg');
      await expect(box).toContainText('Semgrep Rules License');
      await expect(box.getByRole('link', { name: 'Semgrep Rules License' })).toHaveAttribute('href', 'https://semgrep.dev/legal/rules-license');
      await expect(page.locator('#wSgAcc')).not.toBeChecked();
      await page.locator('#wSgAcc').check();
    });

    await step(page, 'Step 2: set the update time to 02:30', async () => {
      await page.getByRole('button', { name: 'Next' }).click();
      await expect(page.getByRole('heading', { name: 'Auto-update scanners' })).toBeVisible();
      await expect(page.getByRole('switch', { name: 'Update daily' })).toHaveAttribute('aria-checked', 'true');
      await page.locator('#wTime').fill('02:30');
    });

    await step(page, 'Click Enable and see the summary', async () => {
      await page.getByRole('button', { name: 'Enable' }).click();
      await expect(page.getByRole('heading', { name: 'Ready' })).toBeVisible();
      await expect(page.getByText('6 scanners enabled · updates daily at 02:30 including vulnerability databases')).toBeVisible();
      await expect(page.locator('#instList .done-row')).toHaveCount(6);
    });

    await step(page, 'Go to ScanHub: the Projects page', async () => {
      await page.getByRole('button', { name: 'Go to ScanHub' }).click();
      await expect(page).toHaveURL(/#projects/);
      await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible();
    });

    await step(page, 'The server saved the schedule and enabled scanners', async () => {
      const s = await api.get('/api/settings');
      expect(s.schedule).toMatchObject({ enabled: true, time: '02:30', updateDb: true });
      const tools = await api.get('/api/tools');
      const on = tools.filter((t) => t.enabled).map((t) => t.id).sort();
      expect(on).toEqual(['checkov', 'dependency-check', 'gitleaks', 'grype', 'semgrep', 'trivy']);
      expect(tools.every((t) => t.installed)).toBe(true);
      expect(s.semgrep).toMatchObject({ mode: 'registry', rules: 'p/default', licenseAccepted: true, acceptedBy: ADMIN.username });
    });
    await api.dispose();
  });
});
