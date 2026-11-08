// Extended Playwright test: step() records a captioned screenshot after each step, and every test ends with a GIF.
import { test as base, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { adminApi, ensureSetup } from './api.js';
import { ADMIN, baseURL, GIF_DIR, LOOK } from './env.js';
import { writeGif } from './gif.js';

const slug = (s) => s.normalize('NFKD').replace(/[^\w-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').toLowerCase();

class Recorder {
  constructor(testInfo) {
    this.testInfo = testInfo;
    this.steps = [];
    this.frames = [];
    this.lastPage = null;
  }

  async frame(page, caption, state) {
    if (!page || page.isClosed()) return;
    try {
      // Wait for any smooth scroll to finish, or the frame catches the page mid-scroll
      await page.evaluate(() => new Promise((done) => {
        let last = -1, still = 0;
        const t0 = performance.now();
        const tick = () => {
          const y = window.scrollY;
          still = y === last ? still + 1 : 0;
          last = y;
          if (still >= 5 || performance.now() - t0 > 2000) done();
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }));
      await page.evaluate(({ caption, state }) => {
        const d = document.createElement('div');
        d.id = '__e2e_caption';
        d.setAttribute('aria-hidden', 'true');
        const color = state === 'fail' ? '#e5484d' : '#4cc38a';
        d.style.cssText = 'position:fixed;left:16px;bottom:16px;z-index:2147483647;max-width:calc(100vw - 32px);display:flex;align-items:center;gap:10px;'
          + 'padding:8px 14px;border-radius:10px;background:rgba(15,15,16,.92);color:#ededed;border:1px solid rgba(237,237,237,.14);'
          + 'font:500 14px/20px "IBM Plex Sans Thai",system-ui,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.25);pointer-events:none';
        const dot = document.createElement('span');
        dot.style.cssText = `width:8px;height:8px;border-radius:50%;flex:none;background:${color}`;
        const t = document.createElement('span');
        t.textContent = caption;
        d.append(dot, t);
        document.documentElement.appendChild(d);
      }, { caption, state });
      const png = await page.screenshot({ animations: 'disabled', caret: 'hide', timeout: 10_000 });
      this.frames.push({ png });
    } catch { /* page navigating or closed: skip this frame */ }
    finally {
      await page.evaluate(() => document.getElementById('__e2e_caption')?.remove()).catch(() => {});
    }
  }

  /** step(page, 'ชื่อขั้นตอน', async () => {...}) */
  async step(page, name, fn) {
    const s = { n: this.steps.length + 1, name, ok: null, ms: 0 };
    this.steps.push(s);
    this.lastPage = page;
    const t0 = Date.now();
    return base.step(name, async () => {
      try {
        const r = fn ? await fn() : undefined;
        s.ok = true;
        s.ms = Date.now() - t0;
        await this.frame(page, `${s.n}. ${name}`, 'ok');
        return r;
      } catch (e) {
        s.ok = false;
        s.ms = Date.now() - t0;
        s.error = String(e.message || e).split('\n')[0].slice(0, 300);
        await this.frame(page, `${s.n}. ${name}`, 'fail');
        throw e;
      }
    });
  }

  /** An extra frame for a key moment inside the current step */
  async snap(page, caption) {
    const cur = this.steps[this.steps.length - 1];
    await this.frame(page, cur ? `${cur.n}. ${cur.name} · ${caption}` : caption, 'ok');
  }

  async finish(browserVersion) {
    const info = this.testInfo;
    let gif = null;
    if (this.frames.length) {
      const file = `${slug(path.basename(info.file, '.spec.js'))}-${slug(info.title).slice(0, 40) || 'test'}-${info.testId.slice(-6)}.gif`;
      try {
        writeGif(this.frames, path.join(GIF_DIR, file));
        gif = `gifs/${file}`;
      } catch (e) { console.warn('gif failed', e); }
    }
    await info.attach('e2e-steps', {
      contentType: 'application/json',
      body: Buffer.from(JSON.stringify({ steps: this.steps, gif, browser: browserVersion })),
    });
  }
}

export const test = base.extend({
  rec: [async ({ browser }, use, testInfo) => {
    fs.mkdirSync(GIF_DIR, { recursive: true });
    const rec = new Recorder(testInfo);
    await use(rec);
    await rec.finish(`Chromium ${browser.version()}`);
  }, { auto: true }],

  step: async ({ rec }, use) => { await use(rec.step.bind(rec)); },
  snap: async ({ rec }, use) => { await use(rec.snap.bind(rec)); },

  // uncaught exceptions in the app fail the test
  page: async ({ page }, use) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await use(page);
    expect(errors, 'uncaught errors in the page').toEqual([]);
  },

  admin: async ({}, use) => {
    const a = await adminApi();
    await ensureSetup(a);
    await use(a);
    await a.dispose();
  },
});

export { expect };

/** Log in through the login form and wait until the app leaves #login */
export async function login(page, username = ADMIN.username, password = ADMIN.password, { expectHash } = {}) {
  if (!page.url().includes('#login')) await page.goto('/#login');
  await page.getByLabel('ชื่อผู้ใช้').fill(username);
  await page.getByLabel('รหัสผ่าน', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'เข้าสู่ระบบ' }).click();
  await expect(page).not.toHaveURL(/#login/);
  if (expectHash) await expect(page).toHaveURL(expectHash);
}

/** Open a fresh browser context logged in as this user */
export async function newUserPage(browser, user, viewport) {
  const ctx = await browser.newContext({ ...LOOK, baseURL: baseURL(), viewport: viewport || { width: 1280, height: 800 }, locale: 'th-TH', timezoneId: 'Asia/Bangkok', acceptDownloads: true });
  const p = await ctx.newPage();
  await p.goto('/#login');
  await login(p, user.username, user.password);
  return { ctx, page: p };
}
