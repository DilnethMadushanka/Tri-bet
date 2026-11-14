// Dice, Mines, Plinko, Coin Flip and the seed tools. Uses helpers from app.js ($, api, fmt, toast, setState, st, cfg).
const G = { page: 'games', busy: {} };
const ef = () => (100 - cfg.houseEdgePct) / 100;
const xm = (m) => `${Number(m).toFixed(2)}x`;

// ---------- amount control (one per game) ----------
function mountAmounts() {
  document.querySelectorAll('.amt-slot').forEach((slot) => {
    const g = slot.dataset.game;
    slot.innerHTML = `<div class="bet-label"><span>Bet amount</span><span class="muted small">${fmt(cfg.minBet, 0)} – ${fmt(cfg.maxBet, 0)}</span></div>
      <div class="amt-row"><button class="step" data-d="-1">−</button><input class="amt-in" type="number" inputmode="decimal" step="1" /><button class="step" data-d="1">+</button></div>
      <div class="quick-amts"><button data-q="half">½</button><button data-q="double">2×</button><button data-q="10">10</button><button data-q="50">50</button><button data-q="100">100</button><button data-q="max">Max</button></div>`;
    const inp = slot.querySelector('input');
    inp.value = store.get(`amt-${g}`) || 10;
    const set = (v) => { inp.value = Math.max(cfg.minBet, Math.min(cfg.maxBet, Math.round(v * 100) / 100)); store.set(`amt-${g}`, inp.value); inp.dispatchEvent(new Event('input')); };
    slot.querySelectorAll('[data-d]').forEach((b) => b.addEventListener('click', () => { const v = Number(inp.value) || 0; set(v + (v >= 100 ? 10 : v >= 10 ? 5 : 1) * Number(b.dataset.d)); }));
    slot.querySelectorAll('[data-q]').forEach((b) => b.addEventListener('click', () => {
      const q = b.dataset.q, v = Number(inp.value) || cfg.minBet;
      set(q === 'half' ? v / 2 : q === 'double' ? v * 2 : q === 'max' ? Math.floor(st.user.balance * 100) / 100 : Number(q));
    }));
    inp.addEventListener('change', () => set(Number(inp.value) || cfg.minBet));
  });
}
const amountOf = (g) => Math.round(Number(document.querySelector(`.amt-slot[data-game="${g}"] input`).value) * 100) / 100;
const amountInput = (g) => document.querySelector(`.amt-slot[data-game="${g}"] input`);
function lockAmount(g, on) { document.querySelectorAll(`.amt-slot[data-game="${g}"] input, .amt-slot[data-game="${g}"] button`).forEach((e) => (e.disabled = on)); }
const showBalance = (n) => { $('balance').textContent = fmt(n); $('lobbyBal').textContent = fmt(n); };

// recent results strips
function renderRecent() {
  document.querySelectorAll('[data-recent]').forEach((el) => {
    const list = (st.plays || []).filter((p) => p.game === el.dataset.recent).slice(0, 20);
    el.innerHTML = list.map((p) => `<span class="rpill ${p.status}" title="Bet ${fmt(p.amount)} · nonce ${p.nonce}">${p.game === 'dice' ? `${p.detail.roll.toFixed(2)} · ` : ''}${xm(p.multiplier)}<small>${p.payout - p.amount >= 0 ? '+' : ''}${fmt(p.payout - p.amount)}</small></span>`).join('')
      || '<span class="muted small">Nothing yet. Your results show up here.</span>';
  });
}

async function play(path, body) {
  try { return await api(path, body); }
  catch (e) { toast(e.message, 'bad'); if (e.status === 401) location.replace('/login'); return null; }
}

// ---------- Dice ----------
const D = { mode: 'under', target: 50 };
const diceChance = () => (D.mode === 'under' ? D.target : Math.round((99.99 - D.target) * 100) / 100);
const diceMult = (c) => Math.floor((ef() * 100 / c) * 10000) / 10000;
function diceSync(from) {
  const lo = D.mode === 'under' ? 1 : 4.99, hi = D.mode === 'under' ? 95 : 98.99;
  D.target = Math.min(hi, Math.max(lo, Math.round(D.target * 100) / 100));
  const c = diceChance(), m = diceMult(c);
  if (from !== 'range') $('diceTarget').value = D.target;
  if (from !== 'target') $('diceTargetIn').value = D.target.toFixed(2);
  if (from !== 'chance') $('diceChance').value = c.toFixed(2);
  $('diceMult').value = `${m.toFixed(4)}x`;
  $('diceWin').textContent = fmt(amountOf('dice') * m);
  const p = D.target;
  $('diceFill').style.background = D.mode === 'under'
    ? `linear-gradient(90deg, var(--accent2) 0 ${p}%, #ff4d6d ${p}% 100%)`
    : `linear-gradient(90deg, #ff4d6d 0 ${p}%, var(--accent2) ${p}% 100%)`;
  store.set('dice', JSON.stringify(D));
}
function initDice() {
  try { Object.assign(D, JSON.parse(store.get('dice') || '{}')); } catch {}
  document.querySelectorAll('#diceMode button').forEach((b) => {
    b.classList.toggle('active', b.dataset.m === D.mode);
    b.addEventListener('click', () => {
      if (b.dataset.m === D.mode) return;
      D.mode = b.dataset.m; D.target = Math.round((100 - D.target) * 100) / 100; // keep the same chance
      document.querySelectorAll('#diceMode button').forEach((x) => x.classList.toggle('active', x === b)); diceSync();
    });
  });
  $('diceTarget').addEventListener('input', () => { D.target = Number($('diceTarget').value); diceSync('range'); });
  $('diceTargetIn').addEventListener('change', () => { D.target = Number($('diceTargetIn').value) || 50; diceSync(); });
  $('diceChance').addEventListener('change', () => {
    const c = Math.min(95, Math.max(1, Number($('diceChance').value) || 50));
    D.target = D.mode === 'under' ? c : 99.99 - c; diceSync();
  });
  amountInput('dice').addEventListener('input', () => diceSync('x'));
  $('diceBtn').addEventListener('click', rollDice);
  diceSync();
}
async function rollDice() {
  if (G.busy.dice) return;
  G.busy.dice = true; $('diceBtn').disabled = true;
  const d = await play('/api/games/dice', { amount: amountOf('dice'), target: D.target, mode: D.mode });
  if (d) {
    const r = d.result;
    showBalance(d.state.user.balance - r.payout);
    const el = $('diceResult'), mk = $('diceMarker');
    mk.classList.remove('hidden', 'won', 'lost');
    mk.style.left = `${r.roll}%`;
    const start = performance.now(), from = Number(el.textContent) || 50;
    await new Promise((res) => {
      const step = (t) => {
        const k = Math.min(1, (t - start) / 450), e = 1 - Math.pow(1 - k, 3);
        el.textContent = (from + (r.roll - from) * e).toFixed(2);
        $('diceMarkerTxt').textContent = el.textContent;
        if (k < 1) requestAnimationFrame(step); else res();
      };
      requestAnimationFrame(step);
    });
    el.className = `dice-result mono ${r.status}`;
    mk.classList.add(r.status);
    if (r.status === 'won') { ding(880); toast(`Rolled ${r.roll.toFixed(2)}: +${fmt(r.payout)} ${cfg.coin}`, 'good'); } else ding(160);
    setState(d.state);
  }
  G.busy.dice = false; $('diceBtn').disabled = false;
}

// ---------- Coin flip ----------
const F = { side: 'heads', deg: 0 };
function initFlip() {
  document.querySelectorAll('#sidePick button').forEach((b) => b.addEventListener('click', () => {
    F.side = b.dataset.s; document.querySelectorAll('#sidePick button').forEach((x) => x.classList.toggle('active', x === b));
  }));
  const upd = () => { $('flipWin').textContent = fmt(amountOf('flip') * cfg.games.flipMultiplier); $('flipMultTxt').textContent = `(${xm(cfg.games.flipMultiplier)})`; };
  amountInput('flip').addEventListener('input', upd); upd();
  $('flipBtn').addEventListener('click', flipCoin);
}
async function flipCoin() {
  if (G.busy.flip) return;
  G.busy.flip = true; $('flipBtn').disabled = true;
  $('flipMsg').textContent = 'Flipping…'; $('flipMsg').className = 'flip-msg';
  const d = await play('/api/games/flip', { amount: amountOf('flip'), side: F.side });
  if (d) {
    const r = d.result;
    showBalance(d.state.user.balance - r.payout);
    F.deg = Math.ceil((F.deg + 1) / 360) * 360 + 1800 + (r.result === 'tails' ? 180 : 0);
    $('coin').style.transform = `rotateY(${F.deg}deg)`;
    await new Promise((res) => setTimeout(res, 1250));
    const name = r.result === 'heads' ? 'Heads' : 'Tails';
    $('flipMsg').textContent = r.status === 'won' ? `${name}! You won ${fmt(r.payout)} ${cfg.coin}` : `${name}. Not this time.`;
    $('flipMsg').className = `flip-msg ${r.status}`;
    r.status === 'won' ? ding(880) : ding(160);
    setState(d.state);
  } else $('flipMsg').textContent = 'Pick a side and flip';
  G.busy.flip = false; $('flipBtn').disabled = false;
}

// ---------- Mines ----------
const M = { ended: null, pending: false };
function initMines() {
  $('minesCount').innerHTML = [...Array(24)].map((_, i) => `<option value="${i + 1}">${i + 1}</option>`).join('');
  $('minesCount').value = store.get('mines') || 3;
  $('minesCount').addEventListener('change', () => { store.set('mines', $('minesCount').value); M.ended = null; renderMines(); });
  $('minesGrid').innerHTML = [...Array(25)].map((_, i) => `<button class="tile" data-t="${i}"></button>`).join('');
  $('minesGrid').addEventListener('click', (e) => { const t = e.target.closest('[data-t]'); if (t) reveal(Number(t.dataset.t)); });
  $('minesBtn').addEventListener('click', async () => {
    if (st.mines) return minesCashout();
    if (M.pending) return;
    M.pending = true;
    const d = await play('/api/games/mines/start', { amount: amountOf('mines'), mines: Number($('minesCount').value) });
    M.pending = false;
    if (d) { M.ended = null; setState(d.state); ding(520); }
  });
  $('minesRandom').addEventListener('click', () => {
    const open = st.mines ? st.mines.revealed : [];
    const left = [...Array(25).keys()].filter((t) => !open.includes(t));
    if (left.length) reveal(left[Math.floor(Math.random() * left.length)]);
  });
  amountInput('mines').addEventListener('input', renderMines);
}
const minesMult = (m, k) => { if (!k) return 1; let x = ef(); for (let i = 0; i < k; i++) x *= (25 - i) / (25 - m - i); return Math.floor(x * 100) / 100; };
async function reveal(t) {
  const g = st.mines;
  if (!g || M.pending || g.revealed.includes(t)) return;
  M.pending = true;
  const tile = $('minesGrid').children[t];
  tile.classList.add('flipping');
  const d = await play('/api/games/mines/reveal', { tile: t });
  M.pending = false;
  tile.classList.remove('flipping');
  if (!d) return;
  const r = d.result;
  if (r.boom) {
    M.ended = { positions: r.positions, revealed: [...g.revealed, t], hit: t, won: false };
    ding(140); $('minesBoard')?.classList.add('shake');
    toast('💥 Boom! You hit a mine.', 'bad');
  } else if (r.done) {
    M.ended = { positions: r.positions, revealed: [...g.revealed, t], won: true, payout: r.payout, multiplier: r.multiplier };
    ding(990); toast(`All gems found! +${fmt(r.payout)} ${cfg.coin}`, 'good');
  } else ding(700 + g.revealed.length * 30);
  setState(d.state);
}
async function minesCashout() {
  if (M.pending) return;
  M.pending = true;
  const g = st.mines;
  const d = await play('/api/games/mines/cashout', {});
  M.pending = false;
  if (!d) return;
  M.ended = { positions: d.result.positions, revealed: g.revealed, won: true, payout: d.result.payout, multiplier: d.result.multiplier };
  ding(880); toast(`Cashed out at ${xm(d.result.multiplier)}: +${fmt(d.result.payout)} ${cfg.coin}`, 'good');
  setState(d.state);
}
function renderMines() {
  if (!st || !$('minesGrid').children.length) return;
  const g = st.mines, e = M.ended;
  const m = g ? g.mines : Number($('minesCount').value);
  [...$('minesGrid').children].forEach((tile, i) => {
    let cls = 'tile';
    if (g) cls += g.revealed.includes(i) ? ' gem open' : ' live';
    else if (e) {
      if (e.revealed.includes(i)) cls += e.positions.includes(i) ? ' bomb open hit' : ' gem open';
      else cls += e.positions.includes(i) ? ' bomb ghost' : ' gem ghost';
    }
    if (tile.className !== cls) tile.className = cls;
    tile.disabled = !g;
  });
  $('minesCount').disabled = !!g;
  if (g) $('minesCount').value = g.mines;
  lockAmount('mines', !!g);
  const k = g ? g.revealed.length : 0;
  $('mGems').textContent = g ? `${k} / ${25 - m}` : e ? `${e.revealed.filter((t) => !e.positions.includes(t)).length}` : '0';
  $('mNow').textContent = xm(g ? g.multiplier : e && e.won ? e.multiplier : 1);
  $('mNext').textContent = g ? (k < 25 - m ? xm(g.next) : '-') : xm(minesMult(m, 1));
  const b = $('minesBtn');
  if (g) {
    b.className = `bet-btn ${k ? 'cash' : 'cancel dim'}`;
    $('minesMain').textContent = 'CASH OUT';
    $('minesSub').textContent = k ? `${fmt(g.amount * g.multiplier)} ${cfg.coin}` : 'Open a tile first';
    b.disabled = !k;
  } else {
    b.className = 'bet-btn go'; b.disabled = false;
    $('minesMain').textContent = 'BET';
    $('minesSub').textContent = `${fmt(amountOf('mines'))} ${cfg.coin} · ${m} mine${m > 1 ? 's' : ''}`;
  }
  $('minesRandom').disabled = !g;
}

// ---------- Plinko ----------
const P = { risk: 'medium', balls: [], W: 0, H: 0, dpr: 1, flash: {} };
function initPlinko() {
  P.risk = store.get('plinko') || 'medium';
  document.querySelectorAll('#plinkoRisk button').forEach((b) => {
    b.classList.toggle('active', b.dataset.r === P.risk);
    b.addEventListener('click', () => { P.risk = b.dataset.r; store.set('plinko', P.risk); document.querySelectorAll('#plinkoRisk button').forEach((x) => x.classList.toggle('active', x === b)); });
  });
  $('plinkoBtn').addEventListener('click', dropBall);
  window.addEventListener('resize', sizePlinko);
  requestAnimationFrame(drawPlinko);
}
function sizePlinko() {
  const cv = $('plinkoCv'); P.dpr = Math.min(2, devicePixelRatio || 1);
  P.W = cv.clientWidth; P.H = cv.clientHeight; cv.width = P.W * P.dpr; cv.height = P.H * P.dpr;
}
function plGeom() {
  const rows = cfg.games.plinko.rows;
  const sp = Math.min(P.W / (rows + 2.2), (P.H - 60) / (rows + 1.2));
  const top = 26, x0 = P.W / 2;
  return { rows, sp, top, x0, slotY: top + rows * sp + sp * 0.35 };
}
let plSeq = 0;
async function dropBall() {
  if ((G.busy.plinko || 0) >= 10) return toast('Easy! Wait for a few balls to land.');
  G.busy.plinko = (G.busy.plinko || 0) + 1;
  const amount = amountOf('plinko'), risk = P.risk, seq = ++plSeq;
  const d = await play('/api/games/plinko', { amount, risk });
  if (!d) { G.busy.plinko--; return; }
  const r = d.result;
  showBalance(Number($('balance').textContent.replace(/,/g, '')) - amount);
  ding(600);
  P.balls.push({ path: r.path, slot: r.slot, risk, start: performance.now(), jitter: (Math.random() - 0.5) * 0.3, onLand: () => {
    G.busy.plinko--;
    P.flash[`${risk}${r.slot}`] = performance.now();
    if (r.multiplier >= 1) ding(r.multiplier >= 5 ? 990 : 760); else ding(220);
    if (r.multiplier >= 5) toast(`Plinko ${xm(r.multiplier)}! +${fmt(r.payout)} ${cfg.coin}`, 'good');
    if (seq === plSeq) setState(d.state); else showBalance(Number($('balance').textContent.replace(/,/g, '')) + r.payout);
  } });
}
function slotColor(i, n) {
  const d = Math.abs(i - (n - 1) / 2) / ((n - 1) / 2); // 0 middle, 1 edge
  const a = [255, 207, 74], b = [255, 77, 109], c = [124, 92, 255];
  const mix = (p, q, t) => p.map((v, k) => Math.round(v + (q[k] - v) * t));
  return `rgb(${(d > 0.5 ? mix(b, a, (d - 0.5) * 2) : mix(c, b, d * 2)).join(',')})`;
}
function drawPlinko(now) {
  requestAnimationFrame(drawPlinko);
  if (G.page !== 'plinko' || !cfg) return;
  if (!P.W) sizePlinko();
  const c = $('plinkoCv').getContext('2d');
  c.setTransform(P.dpr, 0, 0, P.dpr, 0, 0);
  c.clearRect(0, 0, P.W, P.H);
  const { rows, sp, top, x0, slotY } = plGeom();
  // pegs
  c.fillStyle = 'rgba(255,255,255,.75)';
  for (let r = 0; r < rows; r++) {
    for (let k = 0; k <= r + 2; k++) {
      const x = x0 + (k - (r + 2) / 2) * sp, y = top + r * sp;
      c.beginPath(); c.arc(x, y, Math.max(2, sp * 0.09), 0, 7); c.fill();
    }
  }
  // slots
  const table = cfg.games.plinko[P.risk];
  const n = table.length, sw = sp * 0.92, sh = Math.min(30, sp * 0.8);
  c.textAlign = 'center'; c.textBaseline = 'middle';
  c.font = `700 ${Math.max(8, Math.min(12, sp * 0.3))}px JetBrains Mono, monospace`;
  table.forEach((m, i) => {
    const x = x0 + (i - (n - 1) / 2) * sp;
    const f = P.flash[`${P.risk}${i}`]; const bump = f ? Math.max(0, 1 - (now - f) / 300) : 0;
    c.fillStyle = slotColor(i, n);
    c.globalAlpha = 0.85 + bump * 0.15;
    const y = slotY + bump * 6;
    c.beginPath(); c.roundRect ? c.roundRect(x - sw / 2, y, sw, sh, 5) : c.rect(x - sw / 2, y, sw, sh); c.fill();
    c.globalAlpha = 1;
    c.fillStyle = '#0b0d18';
    c.fillText(m >= 100 ? Math.round(m) : m >= 10 ? m.toFixed(0) : m.toFixed(1), x, y + sh / 2 + 1);
  });
  // balls
  const per = 130, rb = Math.max(3.5, sp * 0.2);
  const pos = (b, k) => { // where the ball is after k rows
    let R = 0; for (let i = 0; i < k; i++) R += b.path[i];
    return { x: x0 + (R - k / 2) * sp, y: k >= rows ? slotY + sh / 2 : top + k * sp - rb * 1.3 };
  };
  P.balls = P.balls.filter((b) => {
    const t = (now - b.start) / per;
    let bx, by;
    if (t < 1) { const p0 = pos(b, 0); bx = p0.x + b.jitter * sp * (1 - t); by = top - sp + (p0.y - top + sp) * t * t; }
    else if (t < rows + 1) {
      const s2 = Math.floor(t), k = t - s2, from = pos(b, s2 - 1), to = pos(b, s2);
      bx = from.x + (to.x - from.x) * k;
      by = from.y + (to.y - from.y) * k - Math.sin(Math.PI * k) * sp * (s2 === rows ? 0.1 : 0.3);
    } else { const e = pos(b, rows); bx = e.x; by = e.y; }
    c.fillStyle = '#ff4d6d'; c.shadowColor = '#ff4d6d'; c.shadowBlur = 12;
    c.beginPath(); c.arc(bx, by, rb, 0, 7); c.fill(); c.shadowBlur = 0;
    if (t >= rows + 1.05) { b.onLand(); return false; }
    return true;
  });
}

// ---------- seeds & checking (provably fair page) ----------
const hex2 = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
async function floatsJS(server, client, nonce, count) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(server), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const out = [];
  for (let cur = 0; out.length < count; cur++) {
    const h = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(`${client}:${nonce}:${cur}`)));
    for (let i = 0; i + 4 <= h.length && out.length < count; i += 4) out.push(h[i] / 256 + h[i + 1] / 256 ** 2 + h[i + 2] / 256 ** 3 + h[i + 3] / 256 ** 4);
  }
  return out;
}
function renderSeeds() {
  const s = st.seed; if (!s) return;
  $('seedHash').textContent = s.serverHash;
  $('seedNonce').textContent = s.nonce;
  if (document.activeElement !== $('clientSeed')) $('clientSeed').value = s.clientSeed;
  $('revealedSeeds').innerHTML = s.revealed.map((r, i) => `<div class="act"><div class="act-ic">🔑</div>
    <div><b class="mono brk small">${r.server_seed}</b><div class="muted small">client seed ${esc(r.client_seed)} · nonces 0–${r.last_nonce} · ${ago(r.revealed_at)}</div></div>
    <button class="btn ghost small" data-use="${i}">Check</button></div>`).join('') || '<div class="empty-mini muted">None yet. Change your seed to reveal the current one.</div>';
}
async function runVerify2() {
  const server = $('v2Server').value.trim(), client = $('v2Client').value.trim(), nonce = Number($('v2Nonce').value), g = $('v2Game').value;
  if (!server || !client || !crypto.subtle) return;
  const hash = hex2(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(server)));
  let res = '';
  if (g === 'dice') res = `Roll <b class="mono">${(Math.floor((await floatsJS(server, client, nonce, 1))[0] * 10000) / 100).toFixed(2)}</b>`;
  if (g === 'flip') res = `<b>${(await floatsJS(server, client, nonce, 1))[0] < 0.5 ? 'Heads' : 'Tails'}</b>`;
  if (g === 'plinko') { const p = (await floatsJS(server, client, nonce, 12)).map((x) => (x < 0.5 ? 0 : 1)); res = `Path <span class="mono">${p.map((x) => (x ? 'R' : 'L')).join('')}</span>, slot <b>${p.reduce((a, b) => a + b, 0)}</b> (0 = far left, 12 = far right)`; }
  if (g === 'mines') {
    const m = Math.min(24, Math.max(1, Number($('v2Mines').value) || 3));
    const f = await floatsJS(server, client, nonce, m); const deck = [...Array(25).keys()]; const pos = [];
    for (let i = 0; i < m; i++) pos.push(deck.splice(Math.floor(f[i] * deck.length), 1)[0]);
    res = `Mines on tiles <b class="mono">${pos.map((t) => t + 1).sort((a, b) => a - b).join(', ')}</b> (1 = top left, 25 = bottom right)
      <div class="mini-check">${[...Array(25)].map((_, i) => `<i class="${pos.includes(i) ? 'b' : ''}"></i>`).join('')}</div>`;
  }
  const mine = (st.plays || []).find((p) => p.game === g && p.nonce === nonce && p.client_seed === client && p.server_hash === hash);
  $('v2Out').innerHTML = `<div class="kvline"><span>sha256(server seed)</span><b class="mono trunc">${hash}</b></div>
    <div class="kvline"><span>Result</span><span>${res}</span></div>
    ${mine ? `<div class="verdict ok">✓ Matches your ${g} bet with nonce ${nonce}: ${xm(mine.multiplier)}, ${mine.status}.</div>` : ''}`;
}
function initSeeds() {
  $('rotateSeed').addEventListener('click', async () => {
    const d = await play('/api/seed/rotate', { clientSeed: $('clientSeed').value });
    if (d) { setState(d.state); toast('New seed pair set. Your old server seed is revealed below.', 'good'); }
  });
  $('revealedSeeds').addEventListener('click', (e) => {
    const b = e.target.closest('[data-use]'); if (!b) return;
    const r = st.seed.revealed[Number(b.dataset.use)];
    $('v2Server').value = r.server_seed; $('v2Client').value = r.client_seed; $('v2Nonce').value = r.last_nonce;
    const last = (st.plays || []).find((p) => p.client_seed === r.client_seed && p.nonce === r.last_nonce && p.server_hash === r.server_hash);
    if (last) { $('v2Game').value = last.game; if (last.game === 'mines') $('v2Mines').value = last.detail.mines; }
    runVerify2();
  });
  ['v2Game', 'v2Server', 'v2Client', 'v2Nonce', 'v2Mines'].forEach((id) => $(id).addEventListener('input', runVerify2));
}

// ---------- lobby art ----------
function drawLobbyArt() {
  const svg = document.querySelector('.pl-art'); if (!svg) return;
  let h = '';
  for (let r = 0; r < 6; r++) for (let k = 0; k <= r + 2; k++) h += `<circle cx="${100 + (k - (r + 2) / 2) * 20}" cy="${12 + r * 15}" r="2.6" fill="#fff" opacity=".7"/>`;
  h += '<circle cx="110" cy="42" r="6" fill="#ff4d6d"/>';
  svg.innerHTML = h;
  $('plMaxTxt').textContent = Math.floor(cfg.games.plinko.high[0]);
}

// ---------- hooks from app.js ----------
window.onConfig = () => { mountAmounts(); initDice(); initFlip(); initMines(); initPlinko(); initSeeds(); drawLobbyArt(); };
window.onState = () => { renderRecent(); renderMines(); renderSeeds(); };
window.onRoute = (p) => { G.page = p; if (p === 'plinko') setTimeout(sizePlinko, 0); if (p === 'dice') diceSync(); };
document.addEventListener('keydown', (e) => {
  if (e.code !== 'Space' || /INPUT|SELECT|TEXTAREA|BUTTON/.test(document.activeElement.tagName)) return;
  const btn = { dice: 'diceBtn', flip: 'flipBtn', plinko: 'plinkoBtn', mines: 'minesBtn' }[G.page];
  if (btn) { e.preventDefault(); if (!$(btn).disabled) $(btn).click(); }
});
