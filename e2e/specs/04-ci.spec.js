import { test, expect, login } from '../lib/test.js';
import { projectWithRepo, standardReports, uploadReports, uploadSource, fixture } from '../lib/api.js';
import { SAMPLE_APP } from '../lib/env.js';
import { tgz, tgzWith } from '../lib/source.js';

// A new secret file: Gitleaks reports it as a new Critical finding
const NEW_SECRET = { 'config/prod.yaml': 'aws:\n  access_key_id: AKIAQX7RZ2LMT4VBNW3P\n  secret_access_key: "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"\n' };

test.describe('CI sends code to scan', () => {
  test.setTimeout(15 * 60 * 1000);

  test('Source upload from the snippet: block gives 422, report only gives 200, switchable without editing the pipeline', async ({ page, step, snap, admin }) => {
    const { repo, token } = await projectWithRepo(admin);
    let first;

    await step(page, 'Connect CI: the snippet asks for text/plain and has no fail_on', async () => {
      await page.goto('/#login');
      await login(page);
      await page.goto(`/#connect/${repo.id}`);
      await expect(page.getByRole('heading', { name: 'Connect CI' })).toBeVisible();
      const snip = page.locator('#snip');
      await expect(snip).toContainText('Accept: text/plain');
      await expect(snip).toContainText('/api/v1/scan?');
      await expect(snip).not.toContainText('fail_on');
      await expect(page.getByRole('radio', { name: /Block/ })).toHaveAttribute('aria-checked', 'true');
    });

    await step(page, 'First CI upload: new Critical/High gives 422 with a text summary', async () => {
      first = await uploadSource(token, tgz(SAMPLE_APP), { query: 'branch=main&commit=1111111aaaa&wait=1' });
      expect(first.status).toBe(422);
      expect(first.text).toContain(`ScanHub · ${repo.name} · scan #1`);
      expect(first.text).toContain('Gate:    FAILED');
      expect(first.text).toMatch(/Results: http:\/\/localhost:\d+\/#repo\/\d+\/1/);
      await page.goto(`/#repo/${repo.id}`);
      await expect(page.locator('.scanbar .ttl')).toHaveText('Scan #1');
      await expect(page.locator('.gate-tag')).toContainText('CI: block Critical + High (new)');
    });

    await step(page, 'Switch to Report only on Connect CI', async () => {
      await page.goto(`/#connect/${repo.id}`);
      await page.getByRole('radio', { name: /Report only/ }).first().click();
      await expect(page.locator('#toast')).toContainText('CI: Report only');
      await expect(page.getByRole('radio', { name: /Report only/ }).first()).toHaveAttribute('aria-checked', 'true');
    });

    await step(page, 'Same command, new secret: passes with 200 but still reports it', async () => {
      const r = await uploadSource(token, tgzWith(SAMPLE_APP, NEW_SECRET), { query: 'branch=main&commit=2222222bbbb&wait=1' });
      expect(r.status).toBe(200);
      expect(r.text).toContain('scan #2');
      expect(r.text).toContain('Gate:    PASSED (report only');
      expect(r.text).toContain('report-only mode');
      await page.goto(`/#repo/${repo.id}`);
      await expect(page.locator('.scanbar .ttl')).toHaveText('Scan #2');
      await expect(page.locator('.gate-tag')).toContainText('CI: Report only');
      await snap(page, 'New issues, but the pipeline passes');
    });

    await step(page, 'Back to Block, resend the same code: nothing new, 200', async () => {
      await page.goto(`/#connect/${repo.id}`);
      await page.getByRole('radio', { name: /Block/ }).first().click();
      await expect(page.locator('#toast')).toContainText('CI: block Critical + High (new)');
      const r = await uploadSource(token, tgzWith(SAMPLE_APP, NEW_SECRET), { query: 'branch=main&commit=3333333cccc&wait=1' });
      expect(r.status).toBe(200);
      expect(r.text).toContain('0 new · 0 fixed');
      expect(r.text).toContain('Gate:    PASSED (block');
    });

    await step(page, 'Repo page: scan #3 has no new issues, all existing', async () => {
      await page.goto(`/#repo/${repo.id}`);
      await expect(page.locator('.scanbar .ttl')).toHaveText('Scan #3');
      await expect(page.locator('.nums > div').nth(1).locator('.v')).toHaveText('0');
      await page.locator('[data-view="all"]').click();
      await expect(page.locator('#fList .f-row').first()).toBeVisible();
      await expect(page.locator('#fList .st-new')).toHaveCount(0);
      const scans = await admin.get(`/api/repos/${repo.id}/scans`);
      expect(scans.map((s) => [s.num, s.status, s.newCount])).toEqual([[3, 'done', 0], [2, 'done', scans[1].newCount], [1, 'done', scans[2].newCount]]);
      expect(scans[1].newCount).toBeGreaterThan(0);
      const d = await admin.get(`/api/scans/${scans[0].id}`);
      expect(d.findings.filter((f) => f.status !== 'fixed').every((f) => f.status === 'existing')).toBe(true);
      expect(first.text).toContain('new');
    });
  });

  test('Scanners are chosen in ScanHub; a pipeline can override them with SCANHUB_TOOLS', async ({ page, step, admin }) => {
    const { repo, token } = await projectWithRepo(admin);
    await admin.patch(`/api/repos/${repo.id}`, { tools: ['gitleaks', 'trivy'] });

    await step(page, 'Every CI snippet forwards SCANHUB_TOOLS only when set and bakes in no scanners', async () => {
      await page.goto('/#login');
      await login(page);
      await page.goto(`/#connect/${repo.id}`);
      for (const ci of ['github', 'gitlab', 'jenkins', 'azure', 'bitbucket', 'cli']) {
        await page.locator(`[data-ci="${ci}"]`).click();
        const snip = page.locator('#snip');
        await expect(snip).toContainText('Scanners are chosen in ScanHub. To override here, set SCANHUB_TOOLS=trivy,gitleaks');
        await expect(snip).toContainText('wait=1${SCANHUB_TOOLS:+&tools=$SCANHUB_TOOLS}');
        await expect(snip).not.toContainText('tools=gitleaks');
      }
    });

    await step(page, 'Clicking a scanner chip saves it to the repo right away', async () => {
      const chip = page.locator('#ciTools [data-ct="trivy"]');
      await expect(chip).toHaveAttribute('aria-pressed', 'true');
      await expect(page.locator('#ciTools [data-ct="semgrep"]')).toHaveAttribute('aria-pressed', 'false');
      await chip.click();
      await expect(page.locator('#toast')).toContainText('Saved · scanning with Gitleaks');
      await expect(page.locator('#ciTools [data-ct="trivy"]')).toHaveAttribute('aria-pressed', 'false');
      expect((await admin.get(`/api/repos/${repo.id}`)).tools).toEqual(['gitleaks']);
      await expect(page.getByText('without editing the pipeline').first()).toBeVisible();
    });

    await step(page, 'A pipeline without tools uses the repo choice; an explicit tools param wins', async () => {
      const a = await uploadSource(token, tgz(SAMPLE_APP), { query: 'branch=main&commit=4444444dddd&wait=1' });
      expect([200, 422]).toContain(a.status);
      let scans = await admin.get(`/api/repos/${repo.id}/scans`);
      let d = await admin.get(`/api/scans/${scans[0].id}`);
      expect(d.runs.map((r) => r.tool)).toEqual(['gitleaks']);
      const b = await uploadSource(token, tgz(SAMPLE_APP), { query: 'branch=main&commit=5555555eeee&wait=1&tools=trivy' });
      expect([200, 422]).toContain(b.status);
      scans = await admin.get(`/api/repos/${repo.id}/scans`);
      d = await admin.get(`/api/scans/${scans[0].id}`);
      expect(d.runs.map((r) => r.tool)).toEqual(['trivy']);
    });
  });

  test('Upload results from scanners already in CI (/api/v1/reports)', async ({ page, step, admin }) => {
    const { repo, token } = await projectWithRepo(admin);

    await step(page, 'A wrong token gets 401', async () => {
      const bad = await uploadReports('shr_not_a_real_token', standardReports());
      expect(bad.status).toBe(401);
    });
    await step(page, 'Upload Trivy, Gitleaks, Semgrep: one scan, blocked with 422', async () => {
      const r = await uploadReports(token, standardReports());
      expect(r.status).toBe(422);
      expect(r.json.status).toBe('done');
      expect(r.json.gate.failed).toBe(true);
      expect(r.json.newCount).toBeGreaterThan(0);
      expect(r.json.counts.reduce((a, b) => a + b, 0)).toBe(r.json.newCount);
    });
    await step(page, 'Repo page shows "Uploaded from CI" and 3 scanners', async () => {
      await page.goto('/#login');
      await login(page);
      await page.goto(`/#repo/${repo.id}`);
      await expect(page.locator('.scanbar')).toContainText('Uploaded from CI');
      await expect(page.locator('#runBtn')).toContainText('3 scanner succeeded');
    });
    await step(page, 'Resend with gate=report plus Grype: 200, duplicates merged', async () => {
      const r = await uploadReports(token, [...standardReports(), { tool: 'grype', data: fixture('grype.json') }], { query: 'gate=report', commit: 'e2e0003' });
      expect(r.status).toBe(200);
      expect(r.json.gate.mode).toBe('report');
      const d = await admin.get(`/api/scans/${r.json.scanId}`);
      expect(d.findings.some((f) => f.tools.length > 1)).toBe(true);
      await page.reload();
      await expect(page.locator('.scanbar .ttl')).toHaveText('Scan #2');
      await expect(page.locator('#runBtn')).toContainText('4 scanner succeeded');
    });
    await step(page, 'An unknown report format gets 400', async () => {
      const r = await uploadReports(token, [{ tool: 'nope', data: {} }]);
      expect(r.status).toBe(400);
    });
  });
});
