// Writes e2e/results/index.html: a standalone page with every test, its steps and its GIF.
// Styled with the ScanHub app tokens (design D). Follows unslop by Damir Sokolovsky (@heydamir), CC BY 4.0.
import fs from 'node:fs';
import path from 'node:path';

const RESULTS = path.resolve(import.meta.dirname, 'results');
const LOGO = path.resolve(import.meta.dirname, '..', 'public', 'logo.svg');
const stripAnsi = (s) => String(s || '').replace(/\u001b\[[0-9;]*m/g, '');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const dur = (ms) => { const s = Math.round(ms / 1000); return s >= 60 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s` : `${(ms / 1000).toFixed(1)}s`; };
const TM = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmtDate = (d) => `${d.getDate()} ${TM[d.getMonth()]} ${d.getFullYear()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

export default class ScanHubReporter {
  onBegin(config, suite) {
    this.started = new Date();
    this.total = suite.allTests().length;
    this.tests = [];
  }

  onTestEnd(test, result) {
    const att = result.attachments.find((a) => a.name === 'e2e-steps');
    let meta = { steps: [], gif: null, browser: null };
    if (att?.body) { try { meta = JSON.parse(att.body.toString()); } catch {} }
    const file = path.basename(test.location.file);
    this.tests.push({
      file,
      area: test.parent?.title && test.parent.title !== file ? test.parent.title : file.replace(/^\d+-|\.spec\.js$/g, ''),
      title: test.title,
      status: result.status === 'passed' ? 'passed' : result.status === 'skipped' ? 'skipped' : 'failed',
      rawStatus: result.status,
      duration: result.duration,
      errors: result.errors.map((e) => ({ message: stripAnsi(e.message), stack: stripAnsi(e.stack) })),
      ...meta,
    });
  }

  onEnd(result) {
    let meta = {};
    try { meta = JSON.parse(fs.readFileSync(path.join(RESULTS, '.meta.json'), 'utf8')); } catch {}
    const tests = this.tests;
    const count = (s) => tests.filter((t) => t.status === s).length;
    const passed = count('passed'), failed = count('failed'), skipped = count('skipped');
    const browser = tests.find((t) => t.browser)?.browser || 'Chromium';
    const total = result.duration ?? (Date.now() - this.started);
    let logo = '';
    try { logo = fs.readFileSync(LOGO, 'utf8').replace(/<\?xml[^>]*>/, ''); } catch {}
    fs.mkdirSync(RESULTS, { recursive: true });
    fs.writeFileSync(path.join(RESULTS, 'index.html'), page({ tests, passed, failed, skipped, total, browser, meta, logo, started: this.started, overall: result.status }));
    console.log(`\n[e2e] HTML report: ${path.join(RESULTS, 'index.html')}`);
  }

  printsToStdio() { return false; }
}

function card(t, i) {
  const icon = t.status === 'passed' ? '<span class="st st-pass" title="Passed"><svg viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5"/></svg></span>'
    : t.status === 'skipped' ? '<span class="st st-skip" title="Skipped"><svg viewBox="0 0 24 24"><path d="M5 12h14"/></svg></span>'
    : '<span class="st st-fail" title="Failed"><svg viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></svg></span>';
  const steps = (t.steps || []).map((s) => `<li class="${s.ok === false ? 'bad' : s.ok ? 'ok' : 'nr'}"><span class="si">${s.ok === false ? '✗' : s.ok ? '✓' : '·'}</span><span class="sn">${esc(s.name)}</span><span class="sd mono">${dur(s.ms || 0)}</span>${s.error ? `<div class="se">${esc(s.error)}</div>` : ''}</li>`).join('');
  const err = t.errors.length ? `<details class="err" ${t.status === 'failed' ? 'open' : ''}><summary>Error</summary>${t.errors.map((e) => `<pre>${esc(e.stack || e.message)}</pre>`).join('')}</details>` : '';
  return `<article class="card t ${t.status}" data-status="${t.status}" id="t${i}">
    <header class="t-h">${icon}<div class="t-title"><div class="t-area small">${esc(t.area)}</div><h3>${esc(t.title)}</h3></div><span class="mono small t3">${dur(t.duration)}</span></header>
    <div class="t-body">
      <div class="t-steps">${steps ? `<ol class="steps">${steps}</ol>` : '<p class="small t3">No steps recorded</p>'}${err}</div>
      <div class="t-gif">${t.gif ? `<a href="${esc(t.gif)}" target="_blank" rel="noopener"><img src="${esc(t.gif)}" alt="Recording of ${esc(t.title)}" loading="lazy"></a>` : '<div class="nogif small t3">No recording</div>'}</div>
    </div>
  </article>`;
}

function page({ tests, passed, failed, skipped, total, browser, meta, logo, started, overall }) {
  const ok = failed === 0 && overall === 'passed';
  const areas = [...new Set(tests.map((t) => t.file))];
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ScanHub E2E</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Thai:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
:root{--bg:#fafafa;--card:#fff;--raised:#f4f4f5;--line:rgba(23,23,23,.08);--line2:rgba(23,23,23,.14);--t1:#171717;--t2:#525252;--t3:#737373;
  --acc:#3b6fd8;--acc-text:#2f5fc4;--pos:#16a34a;--pos-soft:rgba(22,163,74,.08);--neg:#dc2626;--neg-soft:rgba(220,38,38,.06);--zero:#c4c4c4;
  --sans:'IBM Plex Sans Thai',system-ui,sans-serif;--mono:'JetBrains Mono',ui-monospace,monospace;--ease:cubic-bezier(.22,1,.36,1);color-scheme:light}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#141415;--card:#19191b;--raised:#232325;--line:rgba(237,237,237,.08);--line2:rgba(237,237,237,.12);
  --t1:#ededed;--t2:#a1a1a6;--t3:#85858b;--acc:#8fb4ff;--acc-text:#8fb4ff;--pos:#4cc38a;--pos-soft:rgba(76,195,138,.1);--neg:#e5484d;--neg-soft:rgba(229,72,77,.08);--zero:#4a4a50;color-scheme:dark}}
:root[data-theme=dark]{--bg:#141415;--card:#19191b;--raised:#232325;--line:rgba(237,237,237,.08);--line2:rgba(237,237,237,.12);
  --t1:#ededed;--t2:#a1a1a6;--t3:#85858b;--acc:#8fb4ff;--acc-text:#8fb4ff;--pos:#4cc38a;--pos-soft:rgba(76,195,138,.1);--neg:#e5484d;--neg-soft:rgba(229,72,77,.08);--zero:#4a4a50;color-scheme:dark}
*{box-sizing:border-box}
html,body{margin:0;background:var(--bg);color:var(--t1);font:400 14px/20px var(--sans);-webkit-font-smoothing:antialiased}
.mono{font-family:var(--mono);font-variant-numeric:tabular-nums}.small{font-size:12px;line-height:16px}.t2{color:var(--t2)}.t3{color:var(--t3)}
:focus-visible{outline:2px solid var(--acc);outline-offset:2px;border-radius:6px}
.top{position:sticky;top:0;z-index:5;background:color-mix(in srgb,var(--bg) 92%,transparent);backdrop-filter:blur(8px);border-bottom:1px solid var(--line)}
.top-in{max-width:1200px;margin:0 auto;padding:0 24px;height:56px;display:flex;align-items:center;gap:16px}
.logo svg{height:24px;width:auto;display:block}.logo .wordmark{fill:var(--t1)}.logo .ribbon{fill:var(--acc)}
.top .sp{flex:1}
.seg{display:inline-flex;padding:2px;border-radius:10px;background:var(--raised);border:1px solid var(--line)}
.seg button{height:28px;padding:0 12px;border-radius:8px;border:0;background:none;color:var(--t2);font:inherit;cursor:pointer;display:inline-flex;align-items:center;gap:6px;transition:background-color .14s var(--ease),color .14s var(--ease)}
.seg button.on{background:var(--card);color:var(--t1);box-shadow:0 1px 2px rgba(0,0,0,.06)}
.seg .n{font-family:var(--mono);font-size:12px;color:var(--t3)}
main{max-width:1200px;margin:0 auto;padding:32px 24px 64px}
h1{font-size:28px;line-height:36px;font-weight:500;margin:0}
.lead{color:var(--t2);margin:4px 0 24px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px}
.sum{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));padding:20px 24px;margin-bottom:12px}
.sum>div+div{padding-left:24px;border-left:1px solid var(--line)}
.k{font-size:13px;color:var(--t2)}.v{font-size:28px;line-height:36px;font-weight:500;margin-top:4px;font-variant-numeric:tabular-nums}
.v.pos{color:var(--pos)}.v.neg{color:var(--neg)}
.verdict{display:flex;align-items:center;gap:10px;padding:14px 20px;margin-bottom:12px;border-radius:12px;border:1px solid var(--line)}
.verdict.ok{background:var(--pos-soft)}.verdict.bad{background:var(--neg-soft)}
.verdict .dot{width:8px;height:8px;border-radius:50%;background:var(--pos)}.verdict.bad .dot{background:var(--neg)}
.metaline{display:flex;flex-wrap:wrap;gap:4px 16px;color:var(--t3);font-size:12px;margin:0 0 32px}
.bar{display:flex;gap:12px;align-items:center;justify-content:space-between;margin:0 0 12px}
.bar h2{font-size:16px;font-weight:500;margin:0}
.list{display:flex;flex-direction:column;gap:12px}
.t-h{display:flex;align-items:center;gap:12px;padding:16px 20px;border-bottom:1px solid var(--line)}
.t-title{flex:1;min-width:0}.t-title h3{font-size:15px;line-height:22px;font-weight:500;margin:0}
.t-area{color:var(--t3);font-family:var(--mono)}
.st{width:24px;height:24px;border-radius:6px;display:grid;place-items:center;flex:none}
.st svg{width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.st-pass{color:var(--pos);background:var(--pos-soft)}.st-fail{color:var(--neg);background:var(--neg-soft)}.st-skip{color:var(--t3);background:var(--raised)}
.t-body{display:grid;grid-template-columns:minmax(0,5fr) minmax(0,7fr);gap:20px;padding:16px 20px}
.steps{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:2px;counter-reset:s}
.steps li{display:grid;grid-template-columns:20px minmax(0,1fr) auto;gap:8px;align-items:baseline;padding:4px 0;font-size:13px;line-height:20px;counter-increment:s}
.steps .si{font-family:var(--mono);color:var(--pos);text-align:center}
.steps li.bad .si{color:var(--neg)}.steps li.bad .sn{color:var(--neg)}.steps li.nr .si{color:var(--t3)}
.steps .sn::before{content:counter(s) ". ";color:var(--t3);font-family:var(--mono);font-size:12px}
.steps .sd{font-size:12px;color:var(--t3)}
.steps .se{grid-column:2/4;font-size:12px;color:var(--neg);overflow-wrap:anywhere}
.t-gif img{display:block;width:100%;height:auto;border-radius:8px;border:1px solid var(--line);background:#141415}
.nogif{height:120px;display:grid;place-items:center;border:1px dashed var(--line2);border-radius:8px}
.err{margin-top:12px;border:1px solid var(--line);border-radius:8px;overflow:hidden}
.err summary{cursor:pointer;padding:8px 12px;color:var(--neg);font-size:13px}
.err pre{margin:0;padding:12px;font:400 12px/18px var(--mono);white-space:pre-wrap;overflow-wrap:anywhere;background:var(--raised);border-top:1px solid var(--line);color:var(--t2);max-height:360px;overflow:auto}
.foot{margin-top:40px;color:var(--t3);font-size:12px;display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap}
.foot a{color:var(--acc-text)}
.theme{height:32px;width:32px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--t2);cursor:pointer;display:grid;place-items:center}
.theme svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:1.5}
.empty{padding:40px;text-align:center;color:var(--t3)}
@media (max-width:860px){.t-body{grid-template-columns:1fr}.sum{grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.sum>div+div{padding-left:0;border-left:0}main{padding:24px 16px 48px}.top-in{padding:0 16px}}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}
</style>
</head>
<body>
<header class="top"><div class="top-in">
  <span class="logo" aria-label="ScanHub">${logo}</span>
  <span class="sp"></span>
  <div class="seg" role="tablist" aria-label="Filter tests">
    <button role="tab" class="on" data-f="all" aria-selected="true">All <span class="n">${tests.length}</span></button>
    <button role="tab" data-f="failed" aria-selected="false">Failed <span class="n">${failed}</span></button>
  </div>
  <button class="theme" id="theme" title="Toggle theme" aria-label="Toggle theme"><svg viewBox="0 0 24 24"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg></button>
</div></header>
<main>
  <h1>E2E test results</h1>
  <p class="lead">End-to-end tests of ScanHub in a real browser. Every test comes with a recording of each step</p>
  <div class="verdict ${ok ? 'ok' : 'bad'}"><span class="dot"></span><span>${ok ? `All ${passed} of ${tests.length} tests passed` : `${failed} of ${tests.length} tests failed`}</span></div>
  <section class="card sum">
    <div><div class="k">Passed</div><div class="v pos">${passed}</div></div>
    <div><div class="k">Failed</div><div class="v ${failed ? 'neg' : ''}">${failed}</div></div>
    <div><div class="k">Skipped</div><div class="v">${skipped}</div></div>
    <div><div class="k">Total time</div><div class="v">${dur(total)}</div></div>
  </section>
  <p class="metaline"><span>${esc(fmtDate(started))}</span><span>ScanHub ${esc(meta.version || '—')}</span><span>${esc(browser)}</span><span>${esc(meta.baseUrl || '')}</span><span>${areas.length} spec files</span></p>
  <div class="bar"><h2>Tests</h2><span class="small t3" id="shown">${tests.length} shown</span></div>
  <div class="list" id="list">${tests.map(card).join('')}</div>
  <div class="card empty" id="none" hidden>No failed tests</div>
  <footer class="foot"><span>Full Playwright report: <a href="playwright/index.html">playwright/index.html</a></span><span>Created by ScanHub E2E</span></footer>
</main>
<script>
const tabs=[...document.querySelectorAll('[data-f]')],cards=[...document.querySelectorAll('.t')];
function show(f){tabs.forEach(b=>{const on=b.dataset.f===f;b.classList.toggle('on',on);b.setAttribute('aria-selected',on)});let n=0;cards.forEach(c=>{const v=f==='all'||c.dataset.status==='failed';c.hidden=!v;if(v)n++});document.getElementById('shown').textContent=n+' shown';document.getElementById('none').hidden=n>0}
tabs.forEach(b=>b.onclick=()=>show(b.dataset.f));
let th=null;try{th=localStorage.getItem('e2e.theme')}catch(e){}
if(th)document.documentElement.dataset.theme=th;
document.getElementById('theme').onclick=()=>{const cur=document.documentElement.dataset.theme||(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light');const n=cur==='dark'?'light':'dark';document.documentElement.dataset.theme=n;try{localStorage.setItem('e2e.theme',n)}catch(e){}};
</script>
</body>
</html>`;
}
