// Copy buttons
document.querySelectorAll('.code .copy').forEach(function (btn) {
  btn.setAttribute('aria-label', 'Copy command');
  btn.addEventListener('click', function () {
    var text = btn.parentElement.querySelector('code').innerText;
    var done = function () {
      btn.textContent = 'Copied';
      btn.classList.add('ok');
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

// OS tabs
var tabs = Array.prototype.slice.call(document.querySelectorAll('.tabs [role=tab]'));
function select(tab) {
  tabs.forEach(function (t) {
    var on = t === tab;
    t.setAttribute('aria-selected', on);
    t.tabIndex = on ? 0 : -1;
    document.getElementById(t.getAttribute('aria-controls')).hidden = !on;
  });
}
tabs.forEach(function (t, i) {
  t.addEventListener('click', function () { select(t); });
  t.addEventListener('keydown', function (e) {
    var d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (d) { var n = tabs[(i + d + tabs.length) % tabs.length]; select(n); n.focus(); }
  });
});
if (/Win/.test(navigator.platform || '')) select(document.getElementById('t-win'));
