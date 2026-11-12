// Copy buttons
var copyStatus = document.createElement('p');
copyStatus.setAttribute('role', 'status');
copyStatus.style.cssText = 'position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)';
document.body.appendChild(copyStatus);
document.querySelectorAll('.code .copy').forEach(function (btn) {
  // name each button after its step, so they are not all "Copy"
  var step = btn.closest('li'), title = step && step.querySelector('h3');
  var what = title ? title.textContent.trim() : 'command';
  btn.setAttribute('aria-label', 'Copy: ' + what);
  btn.addEventListener('click', function () {
    var text = btn.parentElement.querySelector('code').innerText;
    var done = function () {
      btn.textContent = 'Copied';
      btn.classList.add('ok');
      copyStatus.textContent = 'Copied: ' + what;
      setTimeout(function () { btn.textContent = 'Copy'; btn.classList.remove('ok'); }, 1600);
    };
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(done, fallback);
    } else { fallback(); }
    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); done(); } catch (e) {}
      ta.remove();
    }
  });
});

// Tabs (install OS, product tour): click, arrow keys, Home/End
function tablist(list) {
  var tabs = Array.prototype.slice.call(list.querySelectorAll('[role=tab]'));
  function select(tab, focus) {
    tabs.forEach(function (t) {
      var on = t === tab;
      t.setAttribute('aria-selected', on);
      t.tabIndex = on ? 0 : -1;
      document.getElementById(t.getAttribute('aria-controls')).hidden = !on;
    });
    if (focus) { tab.focus(); tab.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }
  }
  tabs.forEach(function (t, i) {
    t.addEventListener('click', function () { select(t); });
    t.addEventListener('keydown', function (e) {
      var n = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : null;
      if (n === null) return;
      e.preventDefault();
      select(tabs[(n + tabs.length) % tabs.length], true);
    });
  });
  return select;
}
var osTabs = document.querySelector('.tabs[role=tablist]');
if (osTabs) {
  var selectOs = tablist(osTabs);
  if (/Win/.test(navigator.platform || '')) selectOs(document.getElementById('t-win'));
}
var tourTabs = document.querySelector('.tour-tabs');
if (tourTabs) tablist(tourTabs);

// Quality gate demo: block vs report only
document.querySelectorAll('[data-gate]').forEach(function (box) {
  var btns = box.querySelectorAll('[data-mode]');
  btns.forEach(function (b) {
    b.addEventListener('click', function () {
      btns.forEach(function (x) { x.setAttribute('aria-pressed', x === b); });
      box.querySelectorAll('[data-out]').forEach(function (o) { o.hidden = o.getAttribute('data-out') !== b.getAttribute('data-mode'); });
    });
  });
});

// Media: a still poster loads first. The animation loads only when it is on screen,
// plays unless the visitor asked for reduced motion, and can always be paused or played.
(function () {
  var reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  var ICON_PAUSE = '<svg viewBox="0 0 12 12" aria-hidden="true"><path fill="currentColor" d="M2 1h3v10H2zM7 1h3v10H7z"/></svg>';
  var ICON_PLAY = '<svg viewBox="0 0 12 12" aria-hidden="true"><path fill="currentColor" d="M2 1l9 5-9 5z"/></svg>';
  var items = Array.prototype.slice.call(document.querySelectorAll('.media[data-anim]'));

  items.forEach(function (fig) {
    var img = fig.querySelector('img');
    var poster = img.getAttribute('src');
    var anim = fig.getAttribute('data-anim');
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'media-btn';
    fig.appendChild(btn);
    // paused by the visitor: stays paused until they press play
    var userPaused = reduce, playing = false;

    function render() {
      btn.innerHTML = (playing ? ICON_PAUSE + 'Pause' : ICON_PLAY + 'Play');
      btn.setAttribute('aria-label', (playing ? 'Pause' : 'Play') + ' animation: ' + img.alt);
    }
    function play() { if (!playing) { img.src = anim; playing = true; fig.classList.add('playing'); render(); } }
    function stop() { if (playing) { img.src = poster; playing = false; fig.classList.remove('playing'); render(); } }

    btn.addEventListener('click', function () {
      if (playing) { userPaused = true; stop(); } else { userPaused = false; play(); }
    });
    fig._inView = function (on) { if (on && !userPaused) play(); else if (!on) stop(); };
    render();
  });

  if (!('IntersectionObserver' in window)) return;
  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) { e.target._inView(e.isIntersecting); });
  }, { threshold: 0.35 });
  items.forEach(function (fig) { io.observe(fig); });
})();

// "Also included" is folded on small screens only
(function () {
  var more = document.querySelector('details.more');
  if (more && window.matchMedia && matchMedia('(max-width: 699px)').matches) more.open = false;
})();
