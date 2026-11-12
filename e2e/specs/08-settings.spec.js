import { test, expect, login } from '../lib/test.js';
import { ensureSemgrepRules, projectWithRepo, uid } from '../lib/api.js';
import { fakeGitFromApp } from '../lib/env.js';

test.describe('Settings', () => {
  test('Scanners can be turned on and off and show their versions', async ({ page, step, admin }) => {
    const toolRow = (name) => page.locator('.tool-row', { has: page.locator('.nm', { hasText: new RegExp(`^${name}$`) }) });

    await step(page, 'Settings lists all 7 scanners with their bundled versions', async () => {
      await page.goto('/#login');
      await login(page);
      await page.getByRole('link', { name: 'Settings', exact: true }).click();
      await expect(page.locator('.tool-row')).toHaveCount(7);
      for (const n of ['Trivy', 'Grype', 'Gitleaks', 'Semgrep', 'Checkov']) {
        await expect(toolRow(n).locator('.mono')).toHaveText(/\d+\.\d+/);
        await expect(toolRow(n)).toContainText('Ready');
      }
    });
    await step(page, 'Turn off Checkov', async () => {
      const before = (await admin.get('/api/tools')).filter((t) => t.enabled).length;
      await page.getByRole('switch', { name: 'Enable Checkov' }).click();
      await expect(page.locator('#toast')).toContainText('Disabled Checkov');
      await expect(toolRow('Checkov')).toContainText('off');
      await expect(page.locator('#instCnt')).toHaveText(`${before - 1} of 7 enabled`);
      expect((await admin.get('/api/tools')).find((t) => t.id === 'checkov').enabled).toBe(false);
    });
    await step(page, 'Turn Checkov back on', async () => {
      await page.getByRole('switch', { name: 'Enable Checkov' }).click();
      await expect(toolRow('Checkov')).toContainText('Ready');
      expect((await admin.get('/api/tools')).find((t) => t.id === 'checkov').enabled).toBe(true);
    });
  });

  test('Semgrep rules: accept the license or use custom rules', async ({ page, step, admin }) => {
    const st = await admin.get('/api/settings');
    test.skip(st.semgrep.fromEnv, 'Semgrep rules come from env on this instance');
    const card = page.locator('#secSemgrep');
    const semgrepRow = page.locator('.tool-row', { has: page.locator('.nm', { hasText: /^Semgrep$/ }) });
    try {
      await step(page, 'Without the license, Semgrep has no rules and is skipped', async () => {
        await admin.put('/api/settings', { semgrep: { mode: null, acceptLicense: false } });
        await page.goto('/#login');
        await login(page);
        await page.goto('/#settings');
        await expect(semgrepRow).toContainText('Choose a rules source');
        await expect(card.locator('#sgStatus')).toContainText('Semgrep skipped: choose a rules source in Settings');
        await expect(card.locator('input[value="registry"]')).toBeDisabled();
      });
      await step(page, 'Accept the license and pick the registry rules', async () => {
        await semgrepRow.getByRole('link', { name: 'Choose a rules source' }).click();
        await expect(card.getByRole('link', { name: 'Semgrep Rules License' })).toHaveAttribute('href', 'https://semgrep.dev/legal/rules-license');
        await card.locator('#sgAcc').check();
        await card.locator('input[value="registry"]').check();
        await card.getByRole('button', { name: 'Save rules' }).click();
        await expect(page.locator('#toast')).toContainText('Semgrep rules saved');
        await expect(card.locator('#sgStatus')).toContainText('Scans use p/default');
        await expect(card.locator('#sgAccBy')).toContainText('Accepted by');
        await expect(semgrepRow).toContainText('Ready');
      });
      await step(page, 'Custom rules cannot be empty', async () => {
        await card.locator('input[value="custom"]').check();
        await card.locator('#sgCustom').fill('');
        await card.getByRole('button', { name: 'Save rules' }).click();
        await expect(page.locator('#toast')).toContainText('Enter the custom rules for Semgrep');
      });
      await step(page, 'Switch to custom rules from a URL', async () => {
        await card.locator('#sgCustom').fill('https://rules.e2e.example/semgrep.yml');
        await card.getByRole('button', { name: 'Save rules' }).click();
        await expect(page.locator('#toast')).toContainText('Semgrep rules saved');
        await expect(card.locator('#sgStatus')).toContainText('Scans use https://rules.e2e.example/semgrep.yml');
        expect((await admin.get('/api/settings')).semgrep).toMatchObject({ mode: 'custom', rules: 'https://rules.e2e.example/semgrep.yml' });
      });
    } finally {
      await ensureSemgrepRules(admin);
    }
  });

  test('About and licenses lists every scanner and its license', async ({ page, step, admin }) => {
    const about = await admin.get('/api/about');
    await step(page, 'Settings shows the ScanHub version and license', async () => {
      await page.goto('/#login');
      await login(page);
      await page.goto('/#settings');
      const sec = page.locator('#secAbout');
      await sec.scrollIntoViewIfNeeded();
      await expect(sec.getByRole('heading', { name: 'About and licenses' })).toBeVisible();
      await expect(sec.locator('#abVer')).toHaveText(`ScanHub ${about.version}`);
      await expect(sec.locator('#abLic')).toHaveText(about.license || 'No license chosen yet');
    });
    await step(page, 'The scanner table shows each license', async () => {
      const rows = page.locator('#licScanners tbody tr');
      await expect(rows).toHaveCount(7);
      for (const [name, lic] of [['Trivy', 'Apache-2.0'], ['Grype', 'Apache-2.0'], ['Gitleaks', 'MIT'], ['Checkov', 'Apache-2.0'], ['OWASP Dependency-Check', 'Apache-2.0'], ['Semgrep (engine)', 'LGPL-2.1'], ['SonarQube Scanner CLI', 'LGPL-3.0']]) {
        await expect(rows.filter({ hasText: name })).toContainText(lic);
      }
      await expect(rows.filter({ hasText: 'Semgrep' })).toContainText('Semgrep Rules License v1.0');
    });
    await step(page, 'Runtime components and the notices file', async () => {
      const rt = page.locator('#licRuntime');
      await rt.scrollIntoViewIfNeeded();
      await expect(rt.locator('tbody tr').filter({ hasText: 'PostgreSQL' })).toContainText('PostgreSQL');
      await expect(rt.locator('tbody tr').filter({ hasText: 'express' })).toContainText('MIT');
      await expect(page.locator('#secAbout')).toContainText('not affiliated with or endorsed by them');
      const res = await admin.raw('GET', '/api/about/notices');
      expect(res.status()).toBe(200);
      expect(await res.text()).toContain('Semgrep Rules License');
    });
  });

  test('Schedule auto-updates and view the log', async ({ page, step, admin }) => {
    const original = (await admin.get('/api/settings')).schedule;
    await step(page, 'Set the update time to 04:15', async () => {
      await page.goto('/#login');
      await login(page);
      await page.goto('/#settings');
      await page.getByLabel('Update time').fill('04:15');
      await expect(page.locator('#toast')).toContainText('Updates daily at 04:15');
      await expect(page.locator('.sec', { hasText: 'Auto-update' }).locator('.sec-h')).toContainText('daily at 04:15');
    });
    await step(page, 'Turn off auto-update', async () => {
      await page.getByRole('switch', { name: 'Update daily' }).click();
      await expect(page.locator('#toast')).toContainText('Auto-update off');
      await expect(page.getByRole('switch', { name: 'Update daily' })).toHaveAttribute('aria-checked', 'false');
      expect((await admin.get('/api/settings')).schedule).toMatchObject({ enabled: false, time: '04:15' });
    });
    await step(page, 'Turn it back on and open the update log', async () => {
      await page.getByRole('switch', { name: 'Update daily' }).click();
      await expect(page.getByRole('switch', { name: 'Update daily' })).toHaveAttribute('aria-checked', 'true');
      await page.locator('#logBox summary').click();
      await expect(page.locator('#logBox .log')).toBeVisible();
      await expect(page.locator('#logBox .log')).toContainText(/enable|disable|No log yet/);
    });
    await admin.put('/api/settings', { schedule: original });
  });

  test('SonarQube from env is locked; NVD key can be saved and cleared', async ({ page, step, admin }) => {
    const st = await admin.get('/api/settings');
    await step(page, 'SonarQube fields show the env values and are read-only', async () => {
      await page.goto('/#login');
      await login(page);
      await page.goto('/#settings');
      const sec = page.locator('#secConn');
      if (st.sonar.fromEnv) {
        await expect(sec.locator('#secSonar')).toContainText('Set from env');
        await expect(sec.getByLabel('URL')).toHaveAttribute('readonly', '');
        await expect(sec.getByLabel('URL')).toHaveValue(st.sonar.url);
        await expect(sec.getByLabel('Token')).toHaveAttribute('placeholder', 'Set from env');
      } else {
        await expect(sec.locator('#secSonar')).toContainText('SONAR_URL');
      }
    });
    await step(page, 'The SonarQube scanner row no longer asks for setup', async () => {
      const r = page.locator('.tool-row', { hasText: 'SonarQube' });
      if (st.sonar.fromEnv) await expect(r).not.toContainText('Set the SonarQube server URL and token');
    });
    await step(page, 'Enter an NVD API key and save', async () => {
      await page.getByLabel('NVD API key').fill('e2e-nvd-key-0000');
      await page.getByRole('button', { name: 'Save connection' }).click();
      await expect(page.locator('#toast')).toContainText('Connection saved');
      await expect(page.getByLabel('NVD API key')).toHaveAttribute('placeholder', /^Set · /);
      expect((await admin.get('/api/settings')).nvdKeySet).toBe(true);
    });
    await step(page, 'Clear the NVD key', async () => {
      await page.getByRole('button', { name: 'Clear key' }).click();
      await expect(page.locator('#toast')).toContainText('Cleared');
      expect((await admin.get('/api/settings')).nvdKeySet).toBe(false);
    });
  });

  test('Add a GitHub connection and test it against the fake API', async ({ page, step, admin }) => {
    const name = uid('Company GitHub');
    await step(page, 'Open the Add Git connection dialog', async () => {
      await page.goto('/#login');
      await login(page);
      await page.goto('/#settings');
      await page.locator('#secGit [data-gitadd]').first().click();
      await expect(page.getByRole('dialog', { name: 'Add Git connection' })).toBeVisible();
    });
    await step(page, 'Fill in name, API URL and token, then add', async () => {
      const dlg = page.getByRole('dialog', { name: 'Add Git connection' });
      await expect(dlg.getByLabel('API URL')).toHaveValue('https://api.github.com');
      await expect(dlg).toContainText('Required permissions');
      await dlg.getByLabel('Display name').fill(name);
      await dlg.getByLabel('API URL').fill(`${fakeGitFromApp()}/gh`);
      await dlg.getByLabel('Token').fill('ghp_e2e_fake_token');
      await dlg.getByRole('button', { name: 'Add and test' }).click();
      await expect(dlg).toBeHidden();
    });
    await step(page, 'Test passes: account octo, all permissions', async () => {
      const r = page.locator('.git-row', { hasText: name });
      await expect(r).toContainText('Tested · account octo');
      await expect(r).toContainText('Working');
    });
    await step(page, 'Delete the connection', async () => {
      const list = await admin.get('/api/integrations');
      const c = list.find((x) => x.name === name);
      await page.getByRole('button', { name: `Delete ${name}` }).click();
      await page.getByRole('dialog', { name: 'Delete connection' }).getByRole('button', { name: 'Delete', exact: true }).click();
      await expect(page.locator('.git-row', { hasText: name })).toHaveCount(0);
      expect((await admin.get('/api/integrations')).some((x) => x.id === c.id)).toBe(false);
    });
  });

  test('General: server URL, scan time and history retention', async ({ page, step, admin }) => {
    const original = await admin.get('/api/settings');
    try {
      await step(page, 'A non-http URL is rejected', async () => {
        await page.goto('/#login');
        await login(page);
        await page.goto('/#settings');
        await page.getByLabel('Server URL').fill('ftp://nope');
        await page.locator('#saveGen').click();
        await expect(page.locator('#toast')).toContainText('Server URL must start with http:// or https://');
      });
      await step(page, 'Change server URL, scan time and keep 90 days of history', async () => {
        await page.getByLabel('Server URL').fill('https://scanhub.e2e.example');
        await page.getByLabel('Daily automatic scan time').fill('01:45');
        await page.getByLabel('Keep scan history').selectOption('90');
        await page.locator('#saveGen').click();
        await expect(page.locator('#toast')).toContainText('Saved');
        const s = await admin.get('/api/settings');
        expect(s).toMatchObject({ serverUrl: 'https://scanhub.e2e.example', scanTime: '01:45', retentionDays: 90 });
      });
      await step(page, 'The CI code uses the new server URL right away', async () => {
        const { repo } = await projectWithRepo(admin);
        await page.goto(`/#connect/${repo.id}`);
        await expect(page.locator('#snip')).toContainText('https://scanhub.e2e.example');
      });
    } finally {
      await admin.put('/api/settings', { serverUrl: original.serverUrl, scanTime: original.scanTime, retentionDays: original.retentionDays });
    }
    await step(page, 'Restore the original values', async () => {
      await page.goto('/#settings');
      await expect(page.getByLabel('Server URL')).toHaveValue(original.serverUrl);
    });
  });
});
