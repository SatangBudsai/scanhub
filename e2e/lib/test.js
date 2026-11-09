// Extended Playwright test: the page is recorded continuously (Chrome screencast) with the current
// step as a caption and a visible cursor, and every test ends with a GIF.
import { test as base, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { adminApi, ensureSetup } from './api.js';
import { ADMIN, baseURL, GIF_DIR, LOOK } from './env.js';
import { writeGif } from './gif.js';

const slug = (s) => s.normalize('NFKD').replace(/[^\w-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').toLowerCase();

// Runs in every recorded page: the step caption and a cursor that glides to each click.
const OVERLAY = () => {
  const mount = () => {
    if (document.getElementById('__e2e_cursor') || !document.documentElement) return;
    const cur = document.createElement('div');
    cur.id = '__e2e_cursor';
    cur.setAttribute('aria-hidden', 'true');
    cur.style.cssText = 'position:fixed;left:0;top:0;width:22px;height:22px;margin:-3px 0 0 -3px;z-index:2147483647;pointer-events:none;'
      + 'transition:transform .35s cubic-bezier(.3,.7,.2,1);transform:translate(-60px,-60px)';
    cur.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24"><path d="M4 2l15 10-6.5 1.3L9 20z" fill="#fff" stroke="#111" stroke-width="1.5" stroke-linejoin="round"/></svg>';
    document.documentElement.appendChild(cur);
    const cap = document.createElement('div');
    cap.id = '__e2e_caption';
    cap.setAttribute('aria-hidden', 'true');
    cap.style.cssText = 'position:fixed;left:16px;bottom:16px;z-index:2147483646;max-width:calc(100vw - 32px);display:none;align-items:center;gap:10px;'
      + 'padding:8px 14px;border-radius:10px;background:rgba(15,15,16,.92);color:#ededed;border:1px solid rgba(237,237,237,.14);'
      + 'font:500 14px/20px "IBM Plex Sans",system-ui,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.25);pointer-events:none';
    // closed shadow root: the caption text stays invisible to Playwright locators (getByText etc.)
    const capRoot = cap.attachShadow({ mode: 'closed' });
    capRoot.innerHTML = '<span style="width:8px;height:8px;border-radius:50%;flex:none;background:#4cc38a"></span><span></span>';
    document.documentElement.appendChild(cap);
    window.__e2eCaption = (text, state) => {
      cap.style.display = text ? 'flex' : 'none';
      capRoot.firstChild.style.background = state === 'fail' ? '#e5484d' : '#4cc38a';
      capRoot.lastChild.textContent = text || '';
      try { sessionStorage.setItem('__e2e_cap', JSON.stringify([text, state])); } catch { /* storage blocked */ }
    };
    try { const c = JSON.parse(sessionStorage.getItem('__e2e_cap') || 'null'); if (c) window.__e2eCaption(...c); } catch { /* none */ }
    addEventListener('mousemove', (e) => { cur.style.transform = `translate(${e.clientX}px,${e.clientY}px)`; }, true);
    addEventListener('mousedown', (e) => {
      const r = document.createElement('div');
      r.style.cssText = `position:fixed;left:${e.clientX - 18}px;top:${e.clientY - 18}px;width:36px;height:36px;border-radius:50%;`
        + 'border:2px solid #5b8cff;z-index:2147483646;pointer-events:none;transition:transform .45s,opacity .45s;transform:scale(.3)';
      document.documentElement.appendChild(r);
      requestAnimationFrame(() => { r.style.transform = 'scale(1.3)'; r.style.opacity = '0'; });
      setTimeout(() => r.remove(), 600);
    }, true);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount); else mount();
};

const MIN_GAP = 70;     // ms between kept frames (about 14 fps)
const MAX_HOLD = 1400;  // long waits (a scan running) are cut down to this
const STEP_HOLD = 900;  // pause on the result of each step

class Recorder {
  constructor(testInfo) {
    this.testInfo = testInfo;
    this.steps = [];
    this.frames = [];   // { png, ts } from the screencast, ts in ms
    this.holds = [];    // moments where the result of a step should linger
    this.page = null;
    this.cdp = null;
    this.ready = new WeakSet();
  }

  /** Stream frames from this page (switches away from the previous one) */
  async watch(page) {
    if (!page || page.isClosed() || page === this.page) return;
    await this.unwatch();
    if (!this.ready.has(page)) {
      this.ready.add(page);
      await page.addInitScript(OVERLAY).catch(() => {});
      await page.evaluate(OVERLAY).catch(() => {});
    }
    try {
      const cdp = await page.context().newCDPSession(page);
      cdp.on('Page.screencastFrame', ({ data, sessionId, metadata }) => {
        cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
        const ts = (metadata?.timestamp || Date.now() / 1000) * 1000;
        const last = this.frames[this.frames.length - 1];
        const f = { png: Buffer.from(data, 'base64'), ts };
        if (last && ts - last.ts < MIN_GAP) this.frames[this.frames.length - 1] = { png: f.png, ts: last.ts }; // keep the newest look
        else this.frames.push(f);
      });
      await cdp.send('Page.startScreencast', { format: 'png', everyNthFrame: 1 });
      this.page = page; this.cdp = cdp;
      page.once('close', () => { if (this.page === page) { this.page = null; this.cdp = null; } });
    } catch { /* not a Chromium page */ }
  }

  async unwatch() {
    const cdp = this.cdp;
    this.page = null; this.cdp = null;
    if (cdp) { await cdp.send('Page.stopScreencast').catch(() => {}); await cdp.detach().catch(() => {}); }
  }

  async caption(page, text, state = 'ok') {
    await page.evaluate(([t, s]) => window.__e2eCaption?.(t, s), [text, state]).catch(() => {});
  }

  /** step(page, 'Step name', async () => {...}) */
  async step(page, name, fn) {
    const s = { n: this.steps.length + 1, name, ok: null, ms: 0 };
    this.steps.push(s);
    await this.watch(page);
    await this.caption(page, `${s.n}. ${name}`);
    const t0 = Date.now();
    return base.step(name, async () => {
      try {
        const r = fn ? await fn() : undefined;
        s.ok = true;
        s.ms = Date.now() - t0;
        await this.settle(page);
        return r;
      } catch (e) {
        s.ok = false;
        s.ms = Date.now() - t0;
        s.error = String(e.message || e).split('\n')[0].slice(0, 300);
        await this.caption(page, `${s.n}. ${name}`, 'fail');
        await this.settle(page);
        throw e;
      }
    });
  }

  /** Let the screen stop moving, then mark this moment to linger on */
  async settle(page) {
    if (!page || page.isClosed()) return;
    await this.watch(page);
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
    })).catch(() => {});
    await page.waitForTimeout(250).catch(() => {});
    this.holds.push(Date.now());
  }

  /** A key moment inside the current step: linger on it (the caption argument is kept for old call sites) */
  async snap(page) { await this.settle(page); }

  /** Frames with real timing: long waits shortened, each step result held a little */
  timeline() {
    const fr = this.frames;
    const holdAt = new Set(this.holds.map((h) => {
      let best = -1; // the frame on screen at that moment
      for (let i = 0; i < fr.length; i++) if (fr[i].ts <= h + 50) best = i;
      return best;
    }));
    return fr.map((f, i) => {
      const next = fr[i + 1];
      let d = next ? Math.min(next.ts - f.ts, MAX_HOLD) : 0;
      if (holdAt.has(i)) d = Math.max(d, STEP_HOLD);
      return { png: f.png, delay: d };
    });
  }

  async finish(browserVersion) {
    await this.unwatch();
    const info = this.testInfo;
    let gif = null;
    if (this.frames.length) {
      const file = `${slug(path.basename(info.file, '.spec.js'))}-${slug(info.title).slice(0, 40) || 'test'}-${info.testId.slice(-6)}.gif`;
      try {
        writeGif(this.timeline(), path.join(GIF_DIR, file), { lastDelay: 2600 });
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
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).not.toHaveURL(/#login/);
  if (expectHash) await expect(page).toHaveURL(expectHash);
}

/** Open a fresh browser context logged in as this user */
export async function newUserPage(browser, user, viewport) {
  const ctx = await browser.newContext({ ...LOOK, baseURL: baseURL(), viewport: viewport || { width: 1280, height: 800 }, locale: 'en-US', timezoneId: 'Asia/Bangkok', acceptDownloads: true });
  const p = await ctx.newPage();
  await p.goto('/#login');
  await login(p, user.username, user.password);
  return { ctx, page: p };
}
