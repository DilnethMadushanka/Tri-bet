// Shared script for /login and /register.
const $ = (s, el = document) => el.querySelector(s);
const fmt = (n, d = 0) => Number(n).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });

async function api(path, body) {
  const res = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(data.error || 'Something went wrong'); e.field = data.field; e.status = res.status; throw e; }
  return data;
}

// Already logged in? Go straight to the app.
fetch('/api/state').then((r) => { if (r.ok) location.replace('/'); });

// Show / hide password
document.querySelectorAll('.pw-eye').forEach((b) => b.addEventListener('click', () => {
  const i = b.parentElement.querySelector('input');
  i.type = i.type === 'password' ? 'text' : 'password';
  b.textContent = i.type === 'password' ? 'Show' : 'Hide';
}));

// Live game preview on the login/register pages
const demo = $('#demoRig');
if (demo) {
  demo.innerHTML = `<div class="lp-head"><span class="lp-dot"></span><b>Live now</b><span class="muted small" id="lpRound"></span></div>
    <div class="lp-mult mono" id="lpMult">1.00x</div><div class="lp-hist" id="lpHist"></div>`;
  let live = null, off = 0;
  const load = async () => {
    try {
      if (!document.hidden) {
        live = await (await fetch('/api/crash/state', { cache: 'no-store' })).json(); off = live.serverNow - Date.now();
        $('#lpRound').textContent = live.round ? `Round #${live.round.id}` : '';
        $('#lpHist').innerHTML = live.history.slice(0, 8).map((h) => `<span class="hpill ${h.crashPoint >= 10 ? 'm-huge' : h.crashPoint >= 2 ? 'm-good' : 'm-low'}">${h.crashPoint.toFixed(2)}x</span>`).join('');
      }
    } catch {}
    setTimeout(load, live && live.round && live.round.status === 'running' ? 700 : 2000);
  };
  load();
  setInterval(() => {
    const r = live && live.round; if (!r) return;
    const el = $('#lpMult');
    if (r.status === 'betting') { el.textContent = `Next round in ${Math.max(0, (r.bettingEndsAt - Date.now() - off) / 1000).toFixed(1)}s`; el.className = 'lp-mult mono wait'; }
    else if (r.status === 'running') { el.textContent = `${Math.max(1, Math.floor(100 * Math.exp(live.growth * (Date.now() + off - r.startedAt))) / 100).toFixed(2)}x`; el.className = 'lp-mult mono run'; }
    else { el.textContent = `Crashed @ ${r.crashPoint.toFixed(2)}x`; el.className = 'lp-mult mono crashed'; }
  }, 50);
}

// Live public stats
(async () => {
  try {
    const [s, cfg] = await Promise.all([api('/api/public-stats'), api('/api/config')]);
    const el = $('#pubStats');
    if (el) el.innerHTML = `
      <div><b class="mono">${fmt(s.users)}</b><span>players</span></div>
      <div><b class="mono">${fmt(s.rounds)}</b><span>rounds played</span></div>
      <div><b class="mono">${s.biggest ? s.biggest.toFixed(2) + 'x' : '-'}</b><span>top today</span></div>`;
    const bt = $('#bonusTxt');
    if (bt) bt.textContent = `${fmt(cfg.signupBonus)} free ${cfg.coin}`;
    window.__cfg = cfg;
    if (cfg.licenseText) $('#licenseText').textContent = '· ' + cfg.licenseText;
    if (typeof onCfg === 'function') onCfg(cfg);
  } catch {}
})();

function setBusy(on, label) {
  const b = $('#submit');
  b.disabled = on; b.dataset.label = b.dataset.label || b.textContent;
  b.innerHTML = on ? `<span class="spinner"></span> ${label}` : b.dataset.label;
}

// ---------- LOGIN ----------
const loginForm = $('#loginForm');
if (loginForm) {
  $('#forgot').addEventListener('click', () => $('#forgotNote').classList.toggle('hidden'));
  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(loginForm);
    if (!f.get('username') || !f.get('password')) { $('#err').textContent = 'Enter your username and password'; return; }
    setBusy(true, 'Logging in…');
    try {
      await api('/api/login', { username: f.get('username').trim(), password: f.get('password'), remember: !!f.get('remember') });
      location.replace('/');
    } catch (err) {
      $('#err').textContent = err.message;
      loginForm.classList.remove('shake'); void loginForm.offsetWidth; loginForm.classList.add('shake');
      setBusy(false);
    }
  });
}

// ---------- REGISTER ----------
const regForm = $('#registerForm');
if (regForm) {
  const inp = (n) => regForm.elements[n];
  const hint = (n, msg, kind = '') => { const h = $(`[data-hint=${n}]`); h.textContent = msg; h.className = `hint ${kind}`; inp(n)?.classList.toggle('bad-input', kind === 'bad'); };

  // ?ref=CODE in the link fills the invite code
  const refParam = new URLSearchParams(location.search).get('ref');
  if (refParam) inp('ref').value = refParam.toUpperCase();

  let refTimer, userTimer;
  async function checkRef() {
    const code = inp('ref').value.trim();
    $('#refBanner').classList.add('hidden');
    if (!code) { hint('ref', ''); return true; }
    const r = await api(`/api/check-ref?code=${encodeURIComponent(code)}`).catch(() => ({ valid: false }));
    if (!r.valid) { hint('ref', 'This invite code is not valid', 'bad'); return false; }
    hint('ref', `Invited by ${r.inviter}`, 'ok');
    const cfg = window.__cfg;
    $('#refBanner').innerHTML = `🎁 <b>${r.inviter}</b> invited you. You get <b>+${cfg ? fmt(cfg.referralSignupBonus) : ''} ${cfg ? cfg.coin : ''}</b> extra when you join.`;
    $('#refBanner').classList.remove('hidden');
    return true;
  }
  window.onCfg = () => { if (inp('ref').value) checkRef(); };
  inp('ref').addEventListener('input', () => { clearTimeout(refTimer); refTimer = setTimeout(checkRef, 350); });

  inp('username').addEventListener('input', () => {
    clearTimeout(userTimer);
    const u = inp('username').value.trim();
    if (!u) return hint('username', '3–20 letters, numbers or _');
    if (!/^[a-zA-Z0-9_]{3,20}$/.test(u)) return hint('username', 'Use 3–20 letters, numbers or _', 'bad');
    hint('username', 'Checking…');
    userTimer = setTimeout(async () => {
      const r = await api(`/api/check-username?u=${encodeURIComponent(u)}`).catch(() => null);
      if (r && inp('username').value.trim() === u) hint('username', r.taken ? 'That username is taken' : 'Username is free', r.taken ? 'bad' : 'ok');
    }, 300);
  });

  function strength(pw) {
    let s = 0;
    if (pw.length >= 8) s++; if (pw.length >= 12) s++;
    if (/[A-Z]/.test(pw) && /[a-z]/.test(pw)) s++;
    if (/\d/.test(pw)) s++; if (/[^A-Za-z0-9]/.test(pw)) s++;
    return Math.min(4, s);
  }
  inp('password').addEventListener('input', () => {
    const pw = inp('password').value, s = strength(pw);
    const colors = ['#f87171', '#f87171', '#fbbf24', '#a3e635', '#34d399'];
    const words = ['Too short', 'Weak', 'OK', 'Good', 'Strong'];
    $('#strengthBar').style.width = pw ? `${(s + 1) * 20}%` : '0';
    $('#strengthBar').style.background = colors[s];
    hint('password', pw.length < 8 ? `At least 8 characters (${pw.length}/8)` : words[s], pw.length < 8 ? '' : s >= 3 ? 'ok' : '');
    if (inp('confirm').value) checkConfirm();
  });
  function checkConfirm() {
    const ok = inp('confirm').value === inp('password').value;
    hint('confirm', inp('confirm').value ? (ok ? 'Passwords match' : "Passwords don't match") : '', ok ? 'ok' : 'bad');
    return ok;
  }
  inp('confirm').addEventListener('input', checkConfirm);
  inp('email').addEventListener('blur', () => {
    const v = inp('email').value.trim();
    hint('email', v && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? 'Email address looks wrong' : '', v && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? 'bad' : '');
  });

  regForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    $('#err').textContent = '';
    const f = Object.fromEntries(new FormData(regForm));
    if (!/^[a-zA-Z0-9_]{3,20}$/.test(f.username || '')) { hint('username', 'Use 3–20 letters, numbers or _', 'bad'); inp('username').focus(); return; }
    if ((f.password || '').length < 8) { hint('password', 'At least 8 characters', 'bad'); inp('password').focus(); return; }
    if (!checkConfirm()) { inp('confirm').focus(); return; }
    if (!(await checkRef())) { inp('ref').focus(); return; }
    if (!f.adult) { $('#err').textContent = 'You must be 18 or older to join'; return; }
    if (!f.agree) { $('#err').textContent = 'Please accept the terms to continue'; return; }
    setBusy(true, 'Creating account…');
    try {
      await api('/api/register', { username: f.username.trim(), email: (f.email || '').trim() || undefined, password: f.password, adult: true, ref: (f.ref || '').trim() || undefined });
      location.replace('/?welcome=1');
    } catch (err) {
      if (err.field) { hint(err.field, err.message, 'bad'); inp(err.field)?.focus(); }
      $('#err').textContent = err.message;
      setBusy(false);
    }
  });
}
