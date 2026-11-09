import fs from 'node:fs';
import path from 'node:path';
import { test, expect, login } from '../lib/test.js';
import { adminApi, ensureSetup, projectWithRepo, uploadSource } from '../lib/api.js';
import { RESULTS, SAMPLE_APP } from '../lib/env.js';
import { tgz, tgzWith } from '../lib/source.js';

// Scan #1: the sample app. Scan #2: the SQL injection file removed (fixed) and a new secret added (new).
const EDITS = {
  'internal/repo/order.go': null,
  'config/prod.yaml': 'aws:\n  access_key_id: AKIAQX7RZ2LMT4VBNW3P\n  secret_access_key: "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"\n',
};

test.describe.serial('Scan results from all scanners', () => {
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

  test('Summary numbers, severity bar and the Needs attention / All / Fixed views', async ({ page, step }) => {
    const open = detail.findings.filter((f) => f.status !== 'fixed');
    const focus = open.filter((f) => f.status === 'new' || f.severity === 'critical' || f.severity === 'high');
    const fixed = detail.findings.filter((f) => f.status === 'fixed');

    await step(page, 'Open the repo: latest scan #2', async () => {
      await page.goto('/#login');
      await login(page);
      await page.goto(`/#repo/${repo.id}`);
      await expect(page.locator('.scanbar .ttl')).toHaveText('Scan #2');
      await expect(page.locator('.scanbar')).toContainText('latest');
    });
    await step(page, 'Open, new and fixed counts match the server', async () => {
      const v = page.locator('.nums .v');
      await expect(v.nth(0)).toHaveText(String(detail.openCount));
      await expect(v.nth(1)).toHaveText(detail.newCount ? `+${detail.newCount}` : '0');
      await expect(v.nth(2)).toHaveText(String(detail.fixedCount));
      expect(detail.newCount).toBeGreaterThan(0);
      expect(detail.fixedCount).toBeGreaterThan(0);
      await expect(page.locator('.sum .sevbar')).toHaveAttribute('aria-label', `Critical ${detail.counts[0]}, High ${detail.counts[1]}, Medium ${detail.counts[2]}, Low ${detail.counts[3]}, Info ${detail.counts[4]}`);
    });
    // banner shot for the README (outside step(), so no caption; overlay hidden)
    {
      const shots = path.join(RESULTS, 'shots');
      fs.mkdirSync(shots, { recursive: true });
      const overlay = (show) => page.evaluate((v) => {
        for (const id of ['__e2e_caption', '__e2e_cursor']) {
          const el = document.getElementById(id);
          if (el) el.style.visibility = v ? '' : 'hidden';
        }
      }, show);
      await overlay(false);
      try { await page.screenshot({ path: path.join(shots, 'repo.png') }); } finally { await overlay(true); }
      const nw = await page.locator('.nums .v').nth(1).textContent();
      fs.writeFileSync(path.join(shots, 'repo.json'), JSON.stringify({ open: detail.openCount, new: nw.trim(), fixed: detail.fixedCount }, null, 2));
    }
    await step(page, 'Needs attention shows only new and Critical/High findings', async () => {
      await expect(page.locator('[data-view="focus"]')).toHaveAttribute('aria-selected', 'true');
      await expect(page.locator('[data-view="focus"] .n')).toHaveText(String(focus.length));
      await expect(page.locator('#fList .f-row')).toHaveCount(focus.length);
    });
    await step(page, 'All shows every open finding', async () => {
      await page.locator('[data-view="all"]').click();
      await expect(page.locator('#fList .f-row')).toHaveCount(open.length);
    });
    await step(page, 'Fixed shows findings gone since the previous scan', async () => {
      await page.locator('[data-view="fixed"]').click();
      await expect(page.locator('#fList .f-row')).toHaveCount(fixed.length);
      await expect(page.locator('#fList .f-st').first()).toHaveText('Fixed');
      await expect(page.locator('#fList')).toContainText('order.go');
    });
    await step(page, 'Click Critical in the severity bar: only Critical findings remain', async () => {
      await page.locator('[data-sevgo="critical"]').click();
      await expect(page.locator('[data-view="all"]')).toHaveAttribute('aria-selected', 'true');
      const rows = page.locator('#fList .f-row .sev');
      await expect(rows).toHaveCount(open.filter((f) => f.severity === 'critical').length);
      for (const t of await rows.allTextContents()) expect(t.trim()).toBe('Critical');
      await expect(page.locator('#fCnt')).toHaveText(' 1');
    });
  });

  test('Search, filters, grouping and a finding reported by several scanners', async ({ page, step, snap }) => {
    const open = detail.findings.filter((f) => f.status !== 'fixed');
    const merged = open.find((f) => f.tools.length > 1 && f.snippet && f.snippet.lines?.length);
    const secrets = open.filter((f) => f.category === 'Secret');

    await step(page, 'Open All and search for a file name', async () => {
      await page.goto('/#login');
      await login(page);
      await page.goto(`/#repo/${repo.id}`);
      await page.locator('[data-view="all"]').click();
      await page.getByPlaceholder('Search', { exact: true }).fill('prod.yaml');
      const rows = page.locator('#fList .f-row');
      await expect(rows.first()).toBeVisible();
      for (const t of await rows.locator('.f-sub .mono').allTextContents()) expect(t).toContain('prod.yaml');
    });
    await step(page, 'Search with no match shows an empty state, then clear the filters', async () => {
      await page.getByPlaceholder('Search', { exact: true }).fill('no-such-thing-xyz');
      await expect(page.locator('#fList')).toContainText('No findings match the filters');
      await page.locator('#fClear2').click();
      await expect(page.locator('#fList .f-row')).toHaveCount(open.length);
    });
    await step(page, 'Open the filter panel and pick category Secret', async () => {
      await page.locator('#fBtn').click();
      await expect(page.locator('#fPanel')).toBeVisible();
      await page.getByLabel('Category').selectOption('Secret');
      await expect(page.locator('#fList .f-row')).toHaveCount(secrets.length);
      expect(secrets.length).toBeGreaterThan(0);
    });
    await step(page, 'Filter by Gitleaks and group by file', async () => {
      await page.getByLabel('Category').selectOption('');
      await page.getByLabel('Scanner').selectOption('gitleaks');
      await expect(page.locator('#fList .f-row')).toHaveCount(open.filter((f) => f.tools.includes('gitleaks')).length);
      await page.locator('[data-group="file"]').click();
      await expect(page.locator('#fList .g-h').first()).toContainText('config/');
    });
    await step(page, 'Group by severity, then by scanner', async () => {
      await page.locator('#fClear').click();
      await page.locator('[data-group="sev"]').click();
      await expect(page.locator('#fList .g-h').first()).toContainText('Critical');
      await page.locator('[data-group="tool"]').click();
      const heads = await page.locator('#fList .g-h > span:first-child').allTextContents();
      expect(heads).toEqual(expect.arrayContaining(['Trivy', 'Gitleaks', 'Semgrep']));
      await page.locator('#fClear').click();
    });
    await step(page, `Open a finding from ${merged.tools.length} scanners: code, location, merged into one`, async () => {
      await page.locator('#fBtn').click();
      await page.getByPlaceholder('Search', { exact: true }).fill(merged.location);
      const row = page.locator(`[data-tog="${merged.id}"]`);
      await row.click();
      const d = page.locator('.f.open .f-detail');
      await expect(d.locator('.code pre')).toBeVisible();
      await expect(d.locator('.code .hl')).toHaveCount(1);
      await expect(d).toContainText('merged into one finding');
      await expect(d.locator('.kv')).toContainText('Found by');
      await snap(page, 'Finding details');
    });
    await step(page, 'Secrets in code are masked, never shown in full', async () => {
      await page.getByPlaceholder('Search', { exact: true }).fill('');
      const html = await page.locator('#fList').innerHTML();
      expect(html).not.toContain('Zk3pQ9vT2mX8rLw4Yb7nC1sD5fG6hJ0aE2uI9oKq');
    });
  });

  test('Scan history, switching scans and CSV download', async ({ page, step }) => {
    await step(page, 'Open the scan history: 2 scans', async () => {
      await page.goto('/#login');
      await login(page);
      await page.goto(`/#repo/${repo.id}`);
      await page.getByRole('button', { name: /History/ }).click();
      await expect(page.locator('#histPop .hist-row')).toHaveCount(2);
    });
    await step(page, 'Switch to scan #1', async () => {
      await page.locator('#histPop .hist-row', { hasText: '#1' }).click();
      await expect(page).toHaveURL(new RegExp(`#repo/${repo.id}/1$`));
      await expect(page.locator('.scanbar .ttl')).toHaveText('Scan #1');
      await expect(page.getByRole('link', { name: 'Go to latest scan' })).toBeVisible();
      await expect(page.locator('.nums .d').first()).toHaveText('First scan of the repo');
    });
    await step(page, 'Download the filtered findings as CSV', async () => {
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
    await step(page, 'Back to the latest scan', async () => {
      await page.getByRole('link', { name: 'Go to latest scan' }).click();
      await expect(page.locator('.scanbar .ttl')).toHaveText('Scan #2');
    });
  });

  test('Scan in progress and failed scans', async ({ page, step, admin }) => {
    await step(page, 'CI uploads without waiting: 202', async () => {
      await page.goto('/#login');
      await login(page);
      const r = await uploadSource(token, tgz(SAMPLE_APP), { query: 'branch=main&commit=cccc3333', text: false });
      expect(r.status).toBe(202);
      expect(r.json.num).toBe(3);
    });
    await step(page, 'The repo page shows scan #3 in progress', async () => {
      await page.goto(`/#repo/${repo.id}/3`);
      await expect(page.getByRole('heading', { name: /(Scanning|Queued) #3/ })).toBeVisible();
    });
    await step(page, 'When it finishes, the page updates to scan #3 results', async () => {
      await expect(page.locator('.scanbar .ttl')).toHaveText('Scan #3', { timeout: 300_000 });
      await expect(page.locator('.sum .nums')).toBeVisible({ timeout: 300_000 });
    });
    await step(page, 'CI uploads a non-tar file: scan fails with 500', async () => {
      const r = await uploadSource(token, Buffer.from('this is not a gzip tar archive'), { query: 'branch=main&commit=dddd4444&wait=1' });
      expect(r.status).toBe(500);
      expect(r.text).toContain('Scan failed');
    });
    await step(page, 'Scan #4 page shows the failure and its reason', async () => {
      await page.goto(`/#repo/${repo.id}/4`);
      await expect(page.getByText('Scan #4 failed')).toBeVisible();
      await expect(page.locator('.failhead .t2')).not.toHaveText('');
    });
    await step(page, 'Projects page shows the latest scan failed', async () => {
      await page.getByRole('link', { name: 'Projects', exact: true }).click();
      const row = page.locator('.repo-row', { hasText: repo.name });
      await expect(row.locator('.status')).toHaveText('Scan failed');
      const scans = await admin.get(`/api/repos/${repo.id}/scans`);
      expect(scans[0]).toMatchObject({ num: 4, status: 'failed' });
    });
  });
});
