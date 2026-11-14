const $ = (id) => document.getElementById(id);
const ICON = { limit: '🛡', bet: '▲', win: '🏆', bet_refund: '↩', signup_bonus: '🎁', referral_signup: '🎁', referral_bonus: '✦', deposit: '＋', withdraw: '↗', withdraw_refund: '↩', admin_adjust: '⚙' };
const LABEL = { limit: 'Play settings', bet: 'Bet', win: 'Cashed out', bet_refund: 'Bet refunded', referral_signup: 'Invite bonus', referral_bonus: 'Referral reward', withdraw_refund: 'Withdrawal refunded', admin_adjust: 'Adjustment', signup_bonus: 'Welcome bonus', deposit: 'Deposit', withdraw: 'Withdraw' };

let cfg = null, st = null;   // config, my account state
let live = null;             // public game state from the server
let clockOffset = 0;         // server time - my time
let myBet = null;            // my bet in the current round
let queued = null;           // a bet waiting for the next round
let betsTab = 'round';
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};

// ---------- helpers ----------
async function api(path, body) {
  const res = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(data.error || 'Request failed'); e.status = res.status; throw e; }
  return data;
}
const fmt = (n, d = 2) => Number(n).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const xs = (m) => `${Number(m).toFixed(2)}x`;
const multClass = (m) => (m >= 10 ? 'm-huge' : m >= 2 ? 'm-good' : 'm-low');
function toast(msg, kind = '') {
  const t = document.createElement('div');
  t.className = `toast ${kind}`; t.textContent = msg;
  $('toasts').appendChild(t);
  setTimeout(() => t.remove(), 3200);
}
function ago(t) {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(t).toLocaleDateString();
}
const serverNow = () => Date.now() + clockOffset;

const TITLES = { games: 'All games', play: 'Crash', dice: 'Dice', mines: 'Mines', plinko: 'Plinko', flip: 'Coin Flip', fair: 'Provably fair', invite: 'Invite friends', wallet: 'Wallet' };
const GAME_PAGES = ['games', 'play', 'dice', 'mines', 'plinko', 'flip'];
function route() {
  const page = (location.hash || '#games').slice(1);
  const p = TITLES[page] ? page : 'games';
  document.querySelectorAll('.page').forEach((s) => s.classList.toggle('active', s.dataset.page === p));
  document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.page === p));
  // phone tab bar: "Games" stays lit on the instant game pages
  document.querySelectorAll('#tabbar a').forEach((a) => a.classList.toggle('active', a.dataset.page === p || (a.dataset.page === 'games' && GAME_PAGES.includes(p) && p !== 'play')));
  $('pageTitle').textContent = TITLES[p];
  document.body.dataset.page = p;
  if (p === 'fair') loadFair();
  if (p === 'play') resizeStage();
  if (window.onRoute) window.onRoute(p);
}
window.addEventListener('hashchange', route);

$('logout').addEventListener('click', async () => { await api('/api/logout', {}).catch(() => {}); location.replace('/login'); });

// ---------- my state ----------
async function refresh() {
  try { setState((await api('/api/state')).state); }
  catch (e) { if (e.status === 401) location.replace('/login'); }
}
function setState(s) {
  const first = !st;
  st = s;
  if (s.myBet !== undefined) myBet = s.myBet;
  $('app').classList.remove('hidden');
  ['navAdmin', 'topAdmin'].forEach((id) => $(id).classList.toggle('hidden', !s.user.isAdmin));
  const pend = (s.withdrawals || []).filter((w) => w.status === 'pending').length;
  $('navWd').textContent = pend; $('navWd').classList.toggle('hidden', !pend);
  $('username').textContent = s.user.username;
  $('avatar').textContent = s.user.username[0].toUpperCase();
  $('balance').textContent = fmt(s.user.balance);
  const t = s.totals;
  $('msBets').textContent = t.bets; $('msWagered').textContent = fmt(t.wagered); $('msWon').textContent = fmt(t.won);
  $('msBest').textContent = t.best ? xs(t.best) : '-';
  $('lobbyBal').textContent = fmt(s.user.balance);
  renderActivity(); renderInvite(); renderPlay(); renderWithdrawals(); renderBets(); renderBetButton();
  if (window.onState) window.onState(s);
  if (first) route();
}
let refreshT = null;
const refreshSoon = () => { clearTimeout(refreshT); refreshT = setTimeout(refresh, 150); };

async function act(path, body, okMsg) {
  try {
    const data = await api(path, body || {});
    setState(data.state);
    if (okMsg) toast(typeof okMsg === 'function' ? okMsg(data) : okMsg, 'good');
    return data;
  } catch (e) { toast(e.message, 'bad'); }
}

// ---------- live game feed ----------
let es = null, lastMsg = 0;
function connect() {
  if (es) es.close();
  es = new EventSource('/api/crash/stream');
  es.onmessage = (m) => { lastMsg = Date.now(); onEvent(JSON.parse(m.data)); };
  es.onerror = () => { $('stageSub').textContent = 'Reconnecting…'; };
}
setInterval(() => { if (Date.now() - lastMsg > 12000) connect(); }, 4000); // watchdog

function onEvent(ev) {
  const prevRound = live?.round?.id;
  live = ev.state;
  clockOffset = live.serverNow - Date.now();
  const r = live.round;
  if (r && r.id !== prevRound) { // a new round
    myBet = null;
    crashedShownFor = null;
  }
  if (ev.type === 'betting' && queued) { const q = queued; queued = null; placeBet(q); }
  if (ev.type === 'cashout' && st && ev.username === st.user.username) {
    if (myBet) Object.assign(myBet, { status: 'won', cashoutAt: ev.multiplier, payout: ev.payout });
    toast(`You cashed out at ${xs(ev.multiplier)}: +${fmt(ev.payout)} ${cfg.coin}`, 'good');
    ding(880);
    refreshSoon();
  }
  if (ev.type === 'crashed') {
    if (myBet && myBet.status === 'active') { myBet.status = 'lost'; }
    if (myBet) refreshSoon();
    boom();
  }
  renderHistory(); renderBets(); renderBetButton();
  const lc = $('lobbyCrash');
  if (lc && r) lc.textContent = r.status === 'running' ? 'LIVE · flying' : r.status === 'betting' ? 'LIVE · bets open' : `LIVE · ${xs(r.crashPoint)}`;
  $('roundId').textContent = r ? `#${r.id}` : '#-';
  $('roundHash').textContent = r ? `${r.hash.slice(0, 10)}…` : '-';
  $('playerCount').textContent = live.playerCount;
  $('totalBet').textContent = fmt(live.totalBet);
}

function renderHistory() {
  $('histStrip').innerHTML = (live?.history || []).map((h) => `<button class="hpill ${multClass(h.crashPoint)}" data-round="${h.id}">${xs(h.crashPoint)}</button>`).join('');
}
$('histStrip').addEventListener('click', (e) => {
  const b = e.target.closest('[data-round]');
  if (b) { location.hash = '#fair'; setTimeout(() => verifyRound(Number(b.dataset.round)), 50); }
});

// ---------- the stage (canvas) ----------
const cv = $('stageCanvas');
let W = 0, H = 0, DPR = 1, crashedShownFor = null, shakeUntil = 0;
function resizeStage() {
  DPR = Math.min(window.devicePixelRatio || 1, 2);
  W = cv.clientWidth; H = cv.clientHeight;
  cv.width = W * DPR; cv.height = H * DPR;
}
window.addEventListener('resize', resizeStage);

const stars = Array.from({ length: 70 }, () => ({ x: Math.random(), y: Math.random(), r: Math.random() * 1.3 + 0.3, s: Math.random() * 0.6 + 0.2 }));

function currentMult(r) {
  if (!r) return 1;
  if (r.status === 'crashed') return r.crashPoint;
  if (r.status !== 'running') return 1;
  return Math.max(1, Math.floor(100 * Math.exp(live.growth * (serverNow() - r.startedAt))) / 100);
}

function frame() {
  requestAnimationFrame(frame);
  if (!live || document.body.dataset.page !== 'play' || !W) return;
  const r = live.round;
  const c = cv.getContext('2d');
  c.setTransform(DPR, 0, 0, DPR, 0, 0);
  c.clearRect(0, 0, W, H);
  const now = serverNow();
  const running = r && r.status === 'running';
  const crashed = r && r.status === 'crashed';
  const m = currentMult(r);
  const elapsed = running ? (now - r.startedAt) / 1000 : crashed && r.startedAt ? Math.log(r.crashPoint) / live.growth / 1000 : 0;

  // shake on crash
  if (Date.now() < shakeUntil) { const k = (shakeUntil - Date.now()) / 40; c.translate((Math.random() - 0.5) * k, (Math.random() - 0.5) * k); }

  // starfield drifting faster as the multiplier climbs
  const speed = running ? Math.min(6, 0.4 + Math.log(m) * 2) : 0.15;
  c.fillStyle = '#fff';
  for (const s of stars) {
    s.x -= (s.s * speed) / 900; s.y += (s.s * speed) / 1800;
    if (s.x < 0) s.x += 1; if (s.y > 1) s.y -= 1;
    c.globalAlpha = 0.15 + s.s * 0.5;
    c.beginPath(); c.arc(s.x * W, s.y * H, s.r, 0, 7); c.fill();
  }
  c.globalAlpha = 1;

  // axes scale
  const padL = 46, padB = 58, padT = 24, padR = 24;
  const gw = W - padL - padR, gh = H - padT - padB;
  const tMax = Math.max(8, elapsed * 1.15);
  const mMax = Math.max(1.8, 1 + (m - 1) * 1.25);
  const X = (t) => padL + (t / tMax) * gw;
  const Y = (v) => padT + gh - ((v - 1) / (mMax - 1)) * gh;

  // grid + labels
  c.strokeStyle = 'rgba(255,255,255,.06)'; c.lineWidth = 1;
  c.fillStyle = 'rgba(255,255,255,.35)'; c.font = '11px JetBrains Mono, monospace';
  const yStep = niceStep((mMax - 1) / 4);
  for (let v = 1; v <= mMax + 1e-9; v += yStep) {
    const y = Y(v); c.beginPath(); c.moveTo(padL, y); c.lineTo(W - padR, y); c.stroke();
    c.textAlign = 'right'; c.fillText(`${v.toFixed(v < 10 ? 1 : 0)}x`, padL - 8, y + 4);
  }
  const tStep = niceStep(tMax / 5);
  c.textAlign = 'center';
  for (let t = 0; t <= tMax + 1e-9; t += tStep) c.fillText(`${Math.round(t)}s`, X(t), H - padB + 18);

  if (running || crashed) {
    // the curve
    const pts = [];
    const N = 80;
    for (let i = 0; i <= N; i++) {
      const t = (elapsed * i) / N;
      pts.push([X(t), Y(Math.min(m, Math.exp(live.growth * t * 1000)))]);
    }
    const col = crashed ? '#ff4d6d' : '#00e0a4';
    const grad = c.createLinearGradient(0, padT, 0, padT + gh);
    grad.addColorStop(0, crashed ? 'rgba(255,77,109,.35)' : 'rgba(0,224,164,.32)');
    grad.addColorStop(1, 'rgba(124,92,255,0)');
    c.beginPath(); c.moveTo(pts[0][0], Y(1));
    for (const [x, y] of pts) c.lineTo(x, y);
    c.lineTo(pts[pts.length - 1][0], Y(1)); c.closePath();
    c.fillStyle = grad; c.fill();
    c.beginPath(); pts.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y)));
    c.strokeStyle = col; c.lineWidth = 4; c.shadowColor = col; c.shadowBlur = 18; c.stroke(); c.shadowBlur = 0;

    // the comet at the tip
    const [tx, ty] = pts[pts.length - 1];
    if (running) {
      const pulse = 1 + Math.sin(Date.now() / 120) * 0.12;
      const g = c.createRadialGradient(tx, ty, 0, tx, ty, 26 * pulse);
      g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.25, 'rgba(0,224,164,.9)'); g.addColorStop(1, 'rgba(124,92,255,0)');
      c.fillStyle = g; c.beginPath(); c.arc(tx, ty, 26 * pulse, 0, 7); c.fill();
      // chevrons pointing up (our logo)
      c.strokeStyle = '#0b0d18'; c.lineWidth = 3; c.lineCap = 'round'; c.lineJoin = 'round';
      c.beginPath(); c.moveTo(tx - 6, ty + 2); c.lineTo(tx, ty - 4); c.lineTo(tx + 6, ty + 2); c.stroke();
    } else {
      // burst
      const age = Math.min(1, (now - (r.endedAt || now)) / 600 + 0.3);
      for (let i = 0; i < 14; i++) {
        const a = (i / 14) * Math.PI * 2, d = 10 + age * 34;
        c.fillStyle = i % 2 ? '#ff4d6d' : '#ffb020';
        c.globalAlpha = 1 - age * 0.7;
        c.beginPath(); c.arc(tx + Math.cos(a) * d, ty + Math.sin(a) * d, 3, 0, 7); c.fill();
      }
      c.globalAlpha = 1;
    }
  }

  // centre text
  const multEl = $('stageMult'), subEl = $('stageSub'), bar = $('stageBar');
  if (!r || live.paused && r.status === 'crashed') {
    multEl.textContent = '—'; multEl.className = 'stage-mult mono';
    subEl.textContent = live.paused ? 'The game is paused. Back soon.' : 'Waiting for the first round…';
    bar.classList.add('hidden');
  } else if (r.status === 'betting') {
    const left = Math.max(0, r.bettingEndsAt - now);
    multEl.textContent = (left / 1000).toFixed(1) + 's';
    multEl.className = 'stage-mult mono wait';
    subEl.textContent = 'Place your bets';
    bar.classList.remove('hidden');
    const total = (cfg && cfg.bettingSeconds ? cfg.bettingSeconds * 1000 : 7000);
    $('stageBarFill').style.width = `${Math.min(100, (left / total) * 100)}%`;
  } else if (running) {
    multEl.textContent = xs(m);
    multEl.className = `stage-mult mono run ${m >= 10 ? 'big' : ''}`;
    subEl.textContent = myBet && myBet.status === 'active' ? `Your ${fmt(myBet.amount)} is now worth ${fmt(myBet.amount * m)}` : myBet && myBet.status === 'won' ? `You cashed out at ${xs(myBet.cashoutAt)} ✓` : 'Flying…';
    bar.classList.add('hidden');
  } else if (crashed) {
    multEl.textContent = xs(r.crashPoint);
    multEl.className = 'stage-mult mono crashed';
    subEl.textContent = myBet && myBet.status === 'won' ? `Crashed! You won ${fmt(myBet.payout)} ✓` : myBet && myBet.status === 'lost' ? 'Crashed! Bet lost' : 'Crashed!';
    bar.classList.add('hidden');
  }
  // live cash-out value on the button
  if (running && myBet && myBet.status === 'active') $('betSub').textContent = `${fmt(myBet.amount * m)} ${cfg.coin}`;
}
function niceStep(raw) {
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / p;
  return (n < 1.5 ? 1 : n < 3.5 ? 2 : n < 7.5 ? 5 : 10) * p;
}
function boom() {
  if (crashedShownFor === live.round.id) return;
  crashedShownFor = live.round.id;
  live.round.endedAt = serverNow();
  shakeUntil = Date.now() + 350;
  $('stage').classList.remove('flash'); void $('stage').offsetWidth; $('stage').classList.add('flash');
  if (myBet) ding(myBet.status === 'won' ? 0 : 160);
}

// ---------- betting ----------
const amountVal = () => Math.round(Number($('betAmount').value) * 100) / 100;
function betParams() {
  return { amount: amountVal(), autoCashout: $('autoOn').checked ? Number($('autoAt').value) : null };
}
async function placeBet(p) {
  try {
    const d = await api('/api/bet', p);
    setState(d.state);
    ding(520);
  } catch (e) { toast(e.message, 'bad'); }
}
$('betBtn').addEventListener('click', async () => {
  const r = live?.round;
  if (!r) return;
  const mode = $('betBtn').dataset.mode;
  if (mode === 'bet') return placeBet(betParams());
  if (mode === 'cancel') return act('/api/bet/cancel', {}, 'Bet cancelled');
  if (mode === 'cashout') {
    $('betBtn').disabled = true;
    try { setState((await api('/api/cashout', {})).state); }
    catch (e) { toast(e.message, 'bad'); }
    finally { renderBetButton(); }
    return;
  }
  if (mode === 'queue') { queued = betParams(); toast(`Bet of ${fmt(queued.amount)} queued for the next round`); return renderBetButton(); }
  if (mode === 'unqueue') { queued = null; return renderBetButton(); }
});

function renderBetButton() {
  const b = $('betBtn'), main = $('betMain'), sub = $('betSub');
  if (!live || !st || !cfg) return;
  const r = live.round;
  const onBreak = st.user.breakUntil > Date.now();
  let mode = 'off', label = 'BET', subl = '', cls = '';
  if (onBreak) { label = 'ON A BREAK'; subl = 'Betting is paused'; }
  else if (!r) { label = 'WAIT'; subl = 'Starting…'; }
  else if (r.status === 'betting') {
    if (myBet && myBet.status === 'active') { mode = 'cancel'; label = 'CANCEL'; subl = `Bet ${fmt(myBet.amount)} placed`; cls = 'cancel'; }
    else { mode = 'bet'; label = 'BET'; subl = `${fmt(amountVal())} ${cfg.coin}`; cls = 'go'; }
  } else if (r.status === 'running' && myBet && myBet.status === 'active') {
    mode = 'cashout'; label = 'CASH OUT'; subl = `${fmt(myBet.amount * currentMult(r))} ${cfg.coin}`; cls = 'cash';
  } else if (queued) { mode = 'unqueue'; label = 'CANCEL'; subl = 'Waiting for next round'; cls = 'cancel'; }
  else if (!live.paused) { mode = 'queue'; label = 'BET'; subl = 'Next round'; cls = 'go dim'; }
  else { label = 'PAUSED'; }
  b.dataset.mode = mode;
  b.className = `bet-btn ${cls}`;
  b.disabled = mode === 'off';
  main.textContent = label; sub.textContent = subl;
  const lock = mode === 'cancel' || mode === 'cashout' || mode === 'unqueue';
  document.querySelectorAll('.betbox input, .betbox .step, .quick-amts button').forEach((el) => (el.disabled = lock));
}

function clampAmount(v) {
  return Math.max(cfg.minBet, Math.min(cfg.maxBet, Math.round(v * 100) / 100));
}
document.querySelectorAll('[data-step]').forEach((b) => b.addEventListener('click', () => {
  const v = amountVal() || 0;
  const step = v >= 100 ? 10 : v >= 10 ? 5 : 1;
  $('betAmount').value = clampAmount(v + step * Number(b.dataset.step)); saveBetPrefs(); renderBetButton();
}));
document.querySelectorAll('[data-q]').forEach((b) => b.addEventListener('click', () => {
  const q = b.dataset.q, v = amountVal() || cfg.minBet;
  const n = q === 'half' ? v / 2 : q === 'double' ? v * 2 : q === 'max' ? Math.min(cfg.maxBet, Math.floor(st.user.balance * 100) / 100) : Number(q);
  $('betAmount').value = clampAmount(n); saveBetPrefs(); renderBetButton();
}));
['betAmount', 'autoAt', 'autoOn'].forEach((id) => $(id).addEventListener('change', () => { saveBetPrefs(); renderBetButton(); }));
$('betAmount').addEventListener('input', renderBetButton);
function saveBetPrefs() { store.set('bet', JSON.stringify({ a: $('betAmount').value, x: $('autoAt').value, on: $('autoOn').checked })); }
function loadBetPrefs() {
  try { const p = JSON.parse(store.get('bet') || '{}'); if (p.a) $('betAmount').value = p.a; if (p.x) $('autoAt').value = p.x; $('autoOn').checked = !!p.on; } catch {}
}
// Space bar = main button
document.addEventListener('keydown', (e) => {
  if (e.code !== 'Space' || document.body.dataset.page !== 'play' || /INPUT|SELECT|TEXTAREA|BUTTON/.test(document.activeElement.tagName)) return;
  e.preventDefault(); if (!$('betBtn').disabled) $('betBtn').click();
});

// ---------- bets list ----------
document.querySelectorAll('#betsTabs button').forEach((b) => b.addEventListener('click', () => {
  betsTab = b.dataset.t;
  document.querySelectorAll('#betsTabs button').forEach((x) => x.classList.toggle('active', x === b));
  renderBets();
}));
function renderBets() {
  if (!live || !st) return;
  let rows;
  if (betsTab === 'round') {
    rows = live.players.map((p) => {
      const me = p.username === st.user.username;
      return `<div class="brow ${p.status} ${me ? 'me' : ''}"><span class="bu"><i class="mini-av">${esc(p.username[0].toUpperCase())}</i>${esc(p.username)}</span>
        <span class="mono">${fmt(p.amount)}</span><span class="mono">${p.cashoutAt ? xs(p.cashoutAt) : p.status === 'lost' ? '💥' : '·'}</span>
        <span class="mono">${p.payout ? fmt(p.payout) : '-'}</span></div>`;
    }).join('') || '<div class="empty-mini muted">No bets yet this round. Be the first!</div>';
  } else {
    rows = st.bets.map((b) => `<div class="brow ${b.status}"><span class="bu">#${b.round_id}<small class="muted">${b.crash_point ? ` · ${xs(b.crash_point)}` : ''}</small></span>
      <span class="mono">${fmt(b.amount)}</span><span class="mono">${b.cashout_at ? xs(b.cashout_at) : b.status === 'lost' ? '💥' : b.status === 'refunded' ? '↩' : '·'}</span>
      <span class="mono">${b.payout ? fmt(b.payout) : '-'}</span></div>`).join('') || '<div class="empty-mini muted">You haven\'t played yet.</div>';
  }
  $('betsList').innerHTML = rows;
}

// ---------- sound ----------
let soundOn = store.get('sound') !== 'off';
let audio = null;
function syncSoundBtn() { $('soundBtn').textContent = soundOn ? '🔊' : '🔇'; $('soundBtn').classList.toggle('off', !soundOn); }
$('soundBtn').addEventListener('click', () => { soundOn = !soundOn; store.set('sound', soundOn ? 'on' : 'off'); syncSoundBtn(); if (soundOn) ding(660); });
function ding(freq) {
  if (!soundOn) return;
  try {
    audio = audio || new (window.AudioContext || window.webkitAudioContext)();
    const o = audio.createOscillator(), g = audio.createGain();
    o.type = freq ? 'sine' : 'triangle';
    o.frequency.setValueAtTime(freq || 660, audio.currentTime);
    if (!freq) o.frequency.exponentialRampToValueAtTime(1320, audio.currentTime + 0.18);
    g.gain.setValueAtTime(0.0001, audio.currentTime);
    g.gain.exponentialRampToValueAtTime(0.15, audio.currentTime + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + 0.3);
    o.connect(g).connect(audio.destination); o.start(); o.stop(audio.currentTime + 0.32);
  } catch {}
}

// ---------- provably fair ----------
async function loadFair() {
  const d = await api('/api/rounds').catch(() => ({ rounds: [] }));
  $('fairTbl').querySelector('tbody').innerHTML = d.rounds.map((r) => `<tr>
    <td>#${r.id}</td><td><span class="hpill ${multClass(r.crash_point)}">${xs(r.crash_point)}</span></td><td>${r.players}</td>
    <td class="mono trunc" title="${r.hash}">${r.hash.slice(0, 16)}…</td><td class="mono trunc" title="${r.seed}">${r.seed.slice(0, 16)}…</td>
    <td><button class="btn ghost small" data-verify="${r.id}">Check</button></td></tr>`).join('') || '<tr><td colspan="6" class="muted">No finished rounds yet.</td></tr>';
}
$('fairTbl').addEventListener('click', (e) => { const b = e.target.closest('[data-verify]'); if (b) verifyRound(Number(b.dataset.verify)); });
let fairRound = null;
async function verifyRound(id) {
  try {
    const d = await api(`/api/rounds/${id}`);
    fairRound = d.round;
    if (!d.round.seed) { $('vOut').innerHTML = '<span class="muted">This round has not finished yet. The seed is revealed after the crash.</span>'; return; }
    $('vSeed').value = d.round.seed; $('vEdge').value = d.round.edge_pct;
    runVerify();
    $('vSeed').scrollIntoView({ behavior: 'smooth', block: 'center' });
  } catch (e) { toast(e.message, 'bad'); }
}
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
async function runVerify() {
  const seed = $('vSeed').value.trim(), edge = Number($('vEdge').value);
  if (!seed) return;
  if (!crypto.subtle) { $('vOut').textContent = 'Your browser cannot check this here (needs HTTPS).'; return; }
  const enc = new TextEncoder();
  const hash = hex(await crypto.subtle.digest('SHA-256', enc.encode(seed)));
  const key = await crypto.subtle.importKey('raw', enc.encode(seed), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const h = hex(await crypto.subtle.sign('HMAC', key, enc.encode('betdouble')));
  const x = parseInt(h.slice(0, 13), 16) / 2 ** 52;
  const cp = Math.max(1, Math.floor((100 - edge) / (1 - x)) / 100);
  const match = fairRound && fairRound.seed === seed;
  const okHash = match ? hash === fairRound.hash : null;
  const okCp = match ? Math.abs(Math.min(cp, cfg.maxMultiplier) - fairRound.crash_point) < 1e-9 : null;
  $('vOut').innerHTML = `
    <div class="kvline"><span>sha256(seed)</span><b class="mono trunc">${hash}</b></div>
    ${match ? `<div class="kvline"><span>Hash shown before round #${fairRound.id}</span><b class="mono trunc">${fairRound.hash}</b></div>` : ''}
    <div class="kvline"><span>Crash point from seed</span><b class="mono">${xs(Math.min(cp, cfg.maxMultiplier))}</b></div>
    ${match ? `<div class="verdict ${okHash && okCp ? 'ok' : 'bad'}">${okHash && okCp ? `✓ Round #${fairRound.id} was fair: the hash matches and the crash point is ${xs(fairRound.crash_point)}.` : '✗ Does not match.'}</div>` : ''}`;
}
$('vSeed').addEventListener('input', () => { fairRound = fairRound && fairRound.seed === $('vSeed').value.trim() ? fairRound : null; runVerify(); });
$('vEdge').addEventListener('input', runVerify);
$('hashBtn').addEventListener('click', () => {
  const r = live?.round; if (!r) return;
  copy(r.hash, `Round #${r.id} hash copied. The seed is shown after the crash.`);
});

// ---------- activity ----------
function actRow(l) {
  return `<div class="act">
    <div class="act-ic">${ICON[l.type] || '•'}</div>
    <div><b>${LABEL[l.type] || esc(l.type)}</b><div class="muted small">${esc(l.note || '')}</div></div>
    <div class="amt ${l.amount < 0 ? 'bad' : l.amount > 0 ? 'good' : ''}">${l.amount > 0 ? '+' : ''}${fmt(l.amount)}<small>${ago(l.created_at)}</small></div>
  </div>`;
}
function renderActivity() {
  const f = $('ledgerFilter').value;
  $('ledger').innerHTML = st.ledger.filter((l) => !f || l.type === f).map(actRow).join('') || '<p class="muted">Nothing here yet</p>';
}
$('ledgerFilter').addEventListener('change', () => st && renderActivity());

// ---------- responsible play ----------
function renderPlay() {
  const u = st.user;
  const onBreak = u.breakUntil > Date.now();
  $('breakBanner').classList.toggle('hidden', !onBreak);
  if (onBreak) $('breakBanner').textContent = `☕ You're on a break until ${new Date(u.breakUntil).toLocaleString()}. Betting and deposits are paused.`;
  if (document.activeElement !== $('limitInput')) $('limitInput').value = u.dailyBetLimit || '';
  $('usedTxt').textContent = `Bet in the last 24 hours: ${fmt(st.totals.used24h)} ${cfg.coin}${u.dailyBetLimit ? ` of your ${fmt(u.dailyBetLimit)} limit` : ''}.`;
}
$('limitSave').addEventListener('click', () => act('/api/play-settings', { dailyBetLimit: Number($('limitInput').value || 0) }, 'Bet limit saved'));
document.querySelectorAll('[data-break]').forEach((b) => b.addEventListener('click', () => {
  if (b.dataset.armed !== '1') { b.dataset.armed = '1'; b.dataset.label = b.textContent; b.textContent = 'Tap again to confirm'; setTimeout(() => { b.dataset.armed = ''; b.textContent = b.dataset.label; }, 4000); return; }
  act('/api/play-settings', { breakDays: Number(b.dataset.break) }, `Break started for ${b.dataset.break} day(s). Take care!`);
}));

// ---------- invite ----------
function renderInvite() {
  const r = st.referrals;
  if (!r) return;
  const link = `${location.origin}/register?ref=${r.code}`;
  $('refLink').value = link;
  $('refCode').textContent = r.code;
  $('refPct').textContent = `${r.pct}%`;
  $('refExplain').textContent = `Share your link. Your friend gets +${fmt(r.signupBonus, 0)} ${cfg.coin} when they join, and you get ${r.pct}% of every bet they play, paid straight to your balance after each round.`;
  $('waShare').href = `https://wa.me/?text=${encodeURIComponent(`Join me on BetDouble and get bonus coins: ${link}`)}`;
  $('refCount').textContent = r.count;
  $('refActive').textContent = r.activeCount;
  $('refEarned').textContent = fmt(r.earned);
  $('refList').innerHTML = r.people.map((p) => `<div class="act">
    <div class="act-ic">${esc(p.username[0].toUpperCase())}</div>
    <div><b>${esc(p.username)}</b><div class="muted small">Joined ${ago(p.joinedAt)} · ${p.bets} bet${p.bets === 1 ? '' : 's'}</div></div>
    <div class="amt ${p.earnedFrom > 0 ? 'good' : ''}">+${fmt(p.earnedFrom)}<small>earned</small></div>
  </div>`).join('') || '<div class="empty-mini muted">No one yet. Share your link to get started.</div>';
}
async function copy(text, msg) {
  try { await navigator.clipboard.writeText(text); toast(msg, 'good'); }
  catch { toast(text); }
}
$('copyLink').addEventListener('click', () => copy($('refLink').value, 'Invite link copied'));
$('copyCode').addEventListener('click', () => copy(st.referrals.code, 'Invite code copied'));
$('shareLink').addEventListener('click', async () => {
  const url = $('refLink').value;
  if (navigator.share) { try { await navigator.share({ title: 'BetDouble', text: 'Join me on BetDouble and get bonus coins', url }); } catch {} }
  else copy(url, 'Sharing is not supported here, so the link was copied');
});

// ---------- withdrawals ----------
function renderWithdrawals() {
  const list = st.withdrawals || [];
  $('wdBox').classList.toggle('hidden', !list.length);
  const pill = { pending: ['warn', 'Waiting'], approved: ['on', 'Approved'], rejected: ['over', 'Rejected'] };
  $('wdList').innerHTML = list.map((w) => `<div class="act">
    <div class="act-ic">↗</div>
    <div><b class="mono">${fmt(w.amount)} ${cfg.coin}</b><div class="muted small">${ago(w.created_at)}${w.admin_note ? ` · ${esc(w.admin_note)}` : ''}</div></div>
    <span class="pill ${pill[w.status][0]}">${pill[w.status][1]}</span>
  </div>`).join('');
}

// ---------- wallet ----------
let walletAction = 'deposit';
document.querySelectorAll('#walletForm button').forEach((b) => b.addEventListener('click', () => (walletAction = b.dataset.action)));
document.querySelectorAll('#chips button').forEach((b) => b.addEventListener('click', () => { document.querySelector('#walletForm input').value = b.dataset.amt; }));
$('walletForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const amount = Number(new FormData(e.target).get('amount'));
  try {
    const data = await api(`/api/${walletAction}`, { amount });
    setState(data.state); e.target.reset(); $('walletErr').textContent = '';
    toast(walletAction === 'deposit' ? `Added ${fmt(amount, 0)} ${cfg.coin}` : `Withdrawal of ${fmt(amount, 0)} ${cfg.coin} requested. An admin will review it.`, 'good');
  } catch (err) { $('walletErr').textContent = err.message; }
});

// ---------- start ----------
(async () => {
  cfg = await api('/api/config');
  document.querySelectorAll('.coin').forEach((c) => (c.textContent = cfg.coin));
  $('walletNote').textContent = cfg.demoDeposits
    ? `Demo mode: coins are virtual. "Add coins" gives free test coins. Withdrawals (min ${cfg.minWithdraw}) go to an admin for approval and pay out nothing real.`
    : 'Deposits are not enabled yet.';
  $('betLimits').textContent = `${fmt(cfg.minBet, 0)} – ${fmt(cfg.maxBet, 0)}`;
  $('betAmount').min = cfg.minBet; $('betAmount').max = cfg.maxBet;
  $('edgeTxt').textContent = cfg.houseEdgePct; $('rtpTxt').textContent = 100 - cfg.houseEdgePct;
  document.querySelectorAll('.edgeN').forEach((e) => (e.textContent = cfg.houseEdgePct));
  document.querySelectorAll('.rtpN').forEach((e) => (e.textContent = 100 - cfg.houseEdgePct));
  if (window.onConfig) window.onConfig(cfg);
  $('vEdge').value = cfg.houseEdgePct;
  if (cfg.licenseText) $('licenseText').textContent = '· ' + cfg.licenseText;
  loadBetPrefs();
  syncSoundBtn();
  await refresh();
  if (new URLSearchParams(location.search).get('welcome')) {
    toast('Welcome! Your bonus coins are in your balance. Place your first bet.', 'good');
    history.replaceState(null, '', '/#games');
  }
  resizeStage();
  connect();
  requestAnimationFrame(frame);
  setInterval(renderBetButton, 500);
  setInterval(() => st && refresh(), 15000);
})();
