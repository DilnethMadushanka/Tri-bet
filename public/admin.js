const $ = (id) => document.getElementById(id);
const fmt = (n, d = 2) => Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let cfg = null;

async function api(path, body) {
  const res = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) { location.replace('/login'); throw new Error('Please log in'); }
  if (!res.ok) { const e = new Error(data.error || 'Request failed'); e.status = res.status; throw e; }
  return data;
}
function toast(msg, kind = '') {
  const t = document.createElement('div');
  t.className = `toast ${kind}`; t.textContent = msg;
  $('toasts').appendChild(t); setTimeout(() => t.remove(), 3200);
}
function ago(t) {
  if (!t) return '—';
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(t).toLocaleDateString();
}
const date = (t) => new Date(t).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
const xs = (m) => `${Number(m).toFixed(2)}x`;
const mcls = (m) => (m >= 10 ? 'm-huge' : m >= 2 ? 'm-good' : 'm-low');

// ---------- routing ----------
const TITLES = { overview: 'Overview', users: 'Users', rounds: 'Games & bets', withdrawals: 'Withdrawals', settings: 'Settings' };
const LOADERS = { overview: loadOverview, users: loadUsers, rounds: loadRounds, withdrawals: loadWithdrawals, settings: loadSettings };
function route() {
  const p = TITLES[(location.hash || '#overview').slice(1)] ? (location.hash || '#overview').slice(1) : 'overview';
  document.querySelectorAll('.page').forEach((s) => s.classList.toggle('active', s.dataset.page === p));
  document.querySelectorAll('#nav a, #tabbar a').forEach((a) => a.classList.toggle('active', a.dataset.page === p));
  $('pageTitle').textContent = TITLES[p];
  LOADERS[p]().catch((e) => toast(e.message, 'bad'));
}
window.addEventListener('hashchange', route);
$('reload').addEventListener('click', route);

// ---------- overview ----------
let ov = null, ovKey = 'profit';
async function loadOverview() {
  ov = await api('/api/admin/overview');
  const tile = (ic, c, label, value, cls = '') => `<div class="stat"><div class="stat-ic ${c}">${ic}</div><div><div class="label">${label}</div><div class="value ${cls}">${value}</div></div></div>`;
  const L = ov.live, r = L.round;
  $('liveAdmin').innerHTML = `<div class="la-row"><span class="lp-dot"></span><b>Live</b>
    <span>${r ? `Round #${r.id} · ${r.status === 'betting' ? 'taking bets' : r.status === 'running' ? `flying at ${xs(r.multiplier)}` : `crashed at ${xs(r.crashPoint)}`}` : 'No round'}</span>
    <span class="muted">${L.playerCount} playing · ${fmt(L.totalBet)} bet</span>
    ${L.paused ? '<span class="pill warn">Paused</span>' : ''}
    <span class="la-hist">${L.history.slice(0, 12).map((h) => `<span class="hpill ${mcls(h.crashPoint)}">${xs(h.crashPoint)}</span>`).join('')}</span></div>`;
  $('ovStats').innerHTML =
    tile('👥', 'c1', 'Users', `${fmt(ov.users, 0)} <small class="muted">+${ov.usersToday} today</small>`) +
    tile('▲', 'c2', 'Played today', `${fmt(ov.playersToday, 0)} <small class="muted">/ ${ov.activeToday} online</small>`) +
    tile('◎', 'c3', 'Wagered today', `${fmt(ov.wageredToday)} <small class="muted">· ${ov.betsToday} bets</small>`) +
    tile('★', 'c4', 'House profit today', fmt(ov.profitToday), ov.profitToday >= 0 ? 'good' : 'bad');
  $('ovMoney').innerHTML =
    tile('◎', 'c1', 'Wagered (all time)', fmt(ov.wagered)) +
    tile('🏆', 'c3', 'Paid to winners', fmt(ov.paid)) +
    tile('★', 'c2', 'House profit (all time)', fmt(ov.profit), ov.profit >= 0 ? 'good' : 'bad') +
    tile('▣', 'c4', 'Held in balances', fmt(ov.totalBalances)) +
    tile('＋', 'c2', 'Demo deposits', fmt(ov.deposits)) +
    tile('↗', 'c4', 'Pending withdrawals', `${ov.withdrawalsPending} <small class="muted">· ${fmt(ov.withdrawalsPendingAmount)}</small>`, ov.withdrawalsPending ? 'warnc' : '') +
    tile('🎁', 'c1', 'Welcome bonuses given', fmt(ov.bonusesPaid)) +
    tile('✦', 'c3', 'Referral rewards paid', fmt(ov.referralPaid));
  const target = 100 - ov.houseEdgePct;
  $('ovEdge').innerHTML = `
    <div class="kvs"><div class="kv"><span>Set house edge</span><b>${ov.houseEdgePct}%</b></div><div class="kv"><span>Bets played (all games)</span><b>${fmt(ov.betsCount, 0)}</b></div>
    <div class="kv"><span>Expected payout to players</span><b>${target}%</b></div><div class="kv"><span>Actual payout so far</span><b class="${ov.rtp == null ? '' : ov.rtp <= target ? 'good' : 'warnc'}">${ov.rtp == null ? '—' : ov.rtp.toFixed(1) + '%'}</b></div></div>
    <p class="muted small">Over many rounds the actual payout moves towards ${target}%. Over a few rounds it swings a lot: one big win can put the house behind for a while. Keep enough coins to cover a max win (${fmt(cfg.maxWin, 0)}).</p>`;
  $('byGameTbl').querySelector('tbody').innerHTML = ov.byGame.map((g) => `<tr>
    <td data-label="Game"><b>${esc(g.name)}</b></td><td data-label="Bets">${fmt(g.bets, 0)}</td>
    <td data-label="Wagered" class="mono">${fmt(g.wagered)}</td><td data-label="Paid out" class="mono">${fmt(g.paid)}</td>
    <td data-label="House profit" class="mono ${g.wagered - g.paid >= 0 ? 'good' : 'bad'}">${fmt(g.wagered - g.paid)}</td>
    <td data-label="Payout %">${g.wagered ? ((g.paid / g.wagered) * 100).toFixed(1) + '%' : '—'}</td></tr>`).join('');
  badges(ov);
  drawBars();
}
function badges(o) {
  $('navWd').textContent = o.withdrawalsPending; $('navWd').classList.toggle('hidden', !o.withdrawalsPending);
}
document.querySelectorAll('#ovSeg button').forEach((b) => b.addEventListener('click', () => {
  ovKey = b.dataset.k; document.querySelectorAll('#ovSeg button').forEach((x) => x.classList.toggle('active', x === b)); drawBars();
}));
function drawBars() {
  const cv = $('ovChart'); if (!ov || !cv.offsetParent) return;
  const dpr = devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight;
  cv.width = w * dpr; cv.height = h * dpr;
  const c = cv.getContext('2d'); c.scale(dpr, dpr);
  const vals = ov.days.map((d) => d[ovKey]);
  const max = Math.max(1, ...vals.map(Math.abs));
  const hasNeg = vals.some((v) => v < 0);
  const pad = { l: 6, r: 6, t: 18, b: 22 }, n = vals.length;
  const bw = (w - pad.l - pad.r) / n;
  const zero = hasNeg ? pad.t + (h - pad.t - pad.b) / 2 : h - pad.b;
  const span = hasNeg ? (h - pad.t - pad.b) / 2 : h - pad.t - pad.b;
  c.font = '11px Inter, sans-serif';
  vals.forEach((v, i) => {
    const bh = (Math.abs(v) / max) * span, x = pad.l + i * bw + bw * 0.18, y = v >= 0 ? zero - bh : zero;
    c.fillStyle = !v ? 'rgba(255,255,255,.06)' : v < 0 ? '#ff4d6d' : ovKey === 'profit' ? '#00e0a4' : '#7c5cff';
    c.beginPath(); c.roundRect ? c.roundRect(x, v ? y : zero - 2, bw * 0.64, v ? bh : 2, 4) : c.rect(x, y, bw * 0.64, bh); c.fill();
    if (v) { c.fillStyle = '#e8ecf5'; const t = ovKey === 'signups' ? String(v) : fmt(v, 0); c.fillText(t, x + bw * 0.32 - c.measureText(t).width / 2, v >= 0 ? y - 5 : y + bh + 12); }
    if ((n - 1 - i) % (w < 500 ? 4 : 2) === 0) {
      c.fillStyle = '#8a93a8'; const d = new Date(ov.days[i].day).toLocaleDateString([], { day: 'numeric', month: 'short' });
      c.fillText(d, x + bw * 0.32 - c.measureText(d).width / 2, h - 6);
    }
  });
}
window.addEventListener('resize', drawBars);

// ---------- users ----------
let searchTimer;
$('userSearch').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(loadUsers, 250); });
async function loadUsers() {
  const { users } = await api(`/api/admin/users?q=${encodeURIComponent($('userSearch').value)}`);
  const tb = $('usersTbl').querySelector('tbody');
  tb.innerHTML = users.map((u) => `<tr data-id="${u.id}" class="click">
    <td data-label="User"><div class="u-cell"><span class="avatar sm">${esc(u.username[0].toUpperCase())}</span><div><b>${esc(u.username)}</b>${u.is_admin ? ' <span class="pill cool">admin</span>' : ''}<div class="muted small">${[u.email ? esc(u.email) : '', u.invited_by ? `invited by ${esc(u.invited_by)}` : ''].filter(Boolean).join(' · ')}</div></div></div></td>
    <td data-label="Balance" class="mono">${fmt(u.balance)}</td>
    <td data-label="Bets" class="mono">${u.bets}</td>
    <td data-label="House result" class="mono ${u.house_profit >= 0 ? 'good' : 'bad'}">${u.house_profit >= 0 ? '+' : ''}${fmt(u.house_profit)}</td>
    <td data-label="Referrals" class="mono">${u.referrals}</td>
    <td data-label="Joined">${ago(u.created_at)}</td>
    <td data-label="Last seen">${ago(u.last_seen)}</td>
    <td data-label="Status">${u.is_banned ? '<span class="pill over">Blocked</span>' : '<span class="pill on">Active</span>'}</td>
  </tr>`).join('') || '<tr><td colspan="8" class="muted">No users found</td></tr>';
  tb.querySelectorAll('tr[data-id]').forEach((tr) => tr.addEventListener('click', () => openUser(Number(tr.dataset.id))));
}

async function openUser(id) {
  const d = await api(`/api/admin/users/${id}`);
  const u = d.user;
  $('drawerBody').innerHTML = `
    <div class="u-head"><span class="avatar lg">${esc(u.username[0].toUpperCase())}</span>
      <div><h3>${esc(u.username)}</h3><div class="muted small">${esc(u.email || 'No email')} · joined ${date(u.created_at)}</div>
      <div class="row" style="margin-top:6px">${u.is_admin ? '<span class="pill cool">Admin</span>' : ''}${u.is_banned ? '<span class="pill over">Blocked</span>' : '<span class="pill on">Active</span>'}</div></div></div>
    <div class="kvs">
      <div class="kv"><span>Balance</span><b>${fmt(u.balance)}</b></div>
      <div class="kv"><span>Invite code</span><b>${esc(u.referral_code || '—')}</b></div>
      <div class="kv"><span>Invited by</span><b>${esc(u.invited_by || '—')}</b></div>
      <div class="kv"><span>Last seen</span><b>${ago(u.last_seen)}</b></div>
      <div class="kv"><span>Bets played</span><b>${d.totals.n} · ${fmt(d.totals.bet)}</b></div>
      <div class="kv"><span>House result from this player</span><b class="${d.totals.bet - d.totals.paid >= 0 ? 'good' : 'bad'}">${fmt(d.totals.bet - d.totals.paid)}</b></div>
      <div class="kv"><span>24h bet limit</span><b>${u.daily_bet_limit ? fmt(u.daily_bet_limit) : 'None'}</b></div>
      <div class="kv"><span>On a break until</span><b>${u.break_until > Date.now() ? date(u.break_until) : '—'}</b></div>
    </div>
    <form id="adjForm" class="sub-card">
      <h4>Adjust balance</h4>
      <div class="row"><input name="amount" type="number" step="any" placeholder="+100 or -50" required style="flex:1" />
      <input name="note" placeholder="Reason" required style="flex:2" /></div>
      <button class="btn primary small" type="submit">Apply</button>
    </form>
    <form id="pwForm" class="sub-card">
      <h4>Reset password</h4>
      <div class="row"><input name="password" type="text" placeholder="New password (8+ characters)" minlength="8" required style="flex:1" />
      <button class="btn ghost small" type="submit">Set password</button></div>
    </form>
    <div class="row" style="margin-bottom:18px">
      <button class="btn ${u.is_banned ? 'ghost' : 'danger'} small" id="banBtn">${u.is_banned ? 'Unblock user' : 'Block user'}</button>
      <button class="btn ghost small" id="adminBtn">${u.is_admin ? 'Remove admin' : 'Make admin'}</button>
    </div>
    <h4>Dice, Mines, Plinko, Flip</h4>
    <div class="activity">${d.plays.slice(0, 20).map((p) => `<div class="act"><div class="act-ic">${{ dice: '🎲', mines: '💣', plinko: '◉', flip: '◐' }[p.game] || '•'}</div>
      <div><b>${GAME_NAMES[p.game] || esc(p.game)} · ${fmt(p.amount)}</b><div class="muted small">${p.status === 'active' ? 'playing' : `${xs(p.multiplier)} · ${p.status}`}</div></div>
      <div class="amt ${p.payout - p.amount >= 0 ? 'good' : 'bad'}">${p.status === 'active' ? '' : (p.payout - p.amount >= 0 ? '+' : '') + fmt(p.payout - p.amount)}<small>${ago(p.created_at)}</small></div></div>`).join('') || '<p class="muted small">None</p>'}</div>
    <h4 style="margin-top:18px">Crash bets</h4>
    <div class="activity">${d.bets.slice(0, 30).map((b) => `<div class="act"><div class="act-ic">▲</div>
      <div><b>Round #${b.round_id} · ${fmt(b.amount)}</b><div class="muted small">${b.status === 'won' ? `cashed out at ${xs(b.cashout_at)}` : b.status}${b.auto_cashout ? ` · auto ${xs(b.auto_cashout)}` : ''}</div></div>
      <div class="amt ${b.status === 'won' ? 'good' : b.status === 'lost' ? 'bad' : ''}">${b.status === 'won' ? '+' + fmt(b.payout - b.amount) : b.status === 'lost' ? '−' + fmt(b.amount) : '0.00'}<small>${ago(b.created_at)}</small></div></div>`).join('') || '<p class="muted small">No bets</p>'}</div>
    <h4 style="margin-top:18px">Referrals (${d.referrals.length})</h4>
    <p class="muted small">${d.referrals.map((r) => esc(r.username)).join(', ') || 'None'}</p>
    <h4 style="margin-top:18px">History</h4>
    <div class="activity">${d.ledger.map((l) => `<div class="act"><div class="act-ic">•</div><div><b>${esc(l.type.replace(/_/g, ' '))}</b><div class="muted small">${esc(l.note || '')}</div></div>
      <div class="amt ${l.amount < 0 ? 'bad' : 'good'}">${l.amount > 0 ? '+' : ''}${fmt(l.amount)}<small>${ago(l.created_at)}</small></div></div>`).join('')}</div>`;
  $('drawer').classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  const after = async (msg) => { toast(msg, 'good'); await openUser(id); loadUsers().catch(() => {}); };
  $('adjForm').addEventListener('submit', async (e) => {
    e.preventDefault(); const f = new FormData(e.target);
    try { await api(`/api/admin/users/${id}/adjust`, { amount: Number(f.get('amount')), note: f.get('note') }); after('Balance updated'); } catch (err) { toast(err.message, 'bad'); }
  });
  $('pwForm').addEventListener('submit', async (e) => {
    e.preventDefault(); const f = new FormData(e.target);
    try { await api(`/api/admin/users/${id}/password`, { password: f.get('password') }); after('Password changed. The user was logged out everywhere.'); } catch (err) { toast(err.message, 'bad'); }
  });
  $('banBtn').addEventListener('click', async () => {
    try { await api(`/api/admin/users/${id}/ban`, { banned: !u.is_banned }); after(u.is_banned ? 'User unblocked' : 'User blocked and logged out'); } catch (err) { toast(err.message, 'bad'); }
  });
  $('adminBtn').addEventListener('click', async () => {
    try { await api(`/api/admin/users/${id}/admin`, { admin: !u.is_admin }); after(u.is_admin ? 'Admin removed' : 'User is now an admin'); } catch (err) { toast(err.message, 'bad'); }
  });
}
document.querySelectorAll('[data-close]').forEach((el) => el.addEventListener('click', closeDrawer));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });
function closeDrawer() { $('drawer').classList.add('hidden'); document.body.style.overflow = ''; }

// ---------- rounds & bets ----------
let rbTab = 'rounds';
document.querySelectorAll('#rbTabs button').forEach((b) => b.addEventListener('click', () => {
  rbTab = b.dataset.s; document.querySelectorAll('#rbTabs button').forEach((x) => x.classList.toggle('active', x === b)); loadRounds();
}));
let playGame = '';
document.querySelectorAll('#playFilter button').forEach((b) => b.addEventListener('click', () => {
  playGame = b.dataset.g; document.querySelectorAll('#playFilter button').forEach((x) => x.classList.toggle('active', x === b)); loadRounds();
}));
const GAME_NAMES = { dice: 'Dice', mines: 'Mines', plinko: 'Plinko', flip: 'Coin Flip' };
async function loadRounds() {
  $('roundsBox').classList.toggle('hidden', rbTab !== 'rounds');
  $('betsBox').classList.toggle('hidden', rbTab !== 'bets' && rbTab !== 'big');
  $('playsBox').classList.toggle('hidden', rbTab !== 'plays');
  if (rbTab === 'plays') {
    const { plays } = await api(`/api/admin/plays?game=${playGame}`);
    const tb = $('playsTbl').querySelector('tbody');
    tb.innerHTML = plays.map((p) => `<tr>
      <td data-label="Player"><a class="link" href="#users" data-user="${p.user_id}">${esc(p.username)}</a></td>
      <td data-label="Game">${GAME_NAMES[p.game] || esc(p.game)}</td>
      <td data-label="Bet" class="mono">${fmt(p.amount)}</td>
      <td data-label="Multiplier" class="mono">${p.status === 'active' ? '—' : xs(p.multiplier)}</td>
      <td data-label="Payout" class="mono">${fmt(p.payout)}</td>
      <td data-label="Result"><span class="pill ${p.status === 'won' ? 'on' : p.status === 'lost' ? 'over' : 'warn'}">${p.status === 'active' ? 'playing' : p.status}</span></td>
      <td data-label="When">${ago(p.created_at)}</td></tr>`).join('') || '<tr><td colspan="7" class="muted">No games yet</td></tr>';
    tb.querySelectorAll('[data-user]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); openUser(Number(a.dataset.user)); }));
    return;
  }
  if (rbTab === 'rounds') {
    const { rounds } = await api('/api/admin/rounds');
    const tb = $('roundsTbl').querySelector('tbody');
    tb.innerHTML = rounds.map((r) => `<tr data-r="${r.id}" class="click">
      <td data-label="Round">#${r.id}</td>
      <td data-label="Crash">${r.status === 'void' ? '<span class="pill">void</span>' : `<span class="hpill ${mcls(r.crash_point)}">${xs(r.crash_point)}</span>`}</td>
      <td data-label="Ended">${r.ended_at ? date(r.ended_at) : '—'}</td>
      <td data-label="Players">${r.players}</td>
      <td data-label="Bet" class="mono">${fmt(r.total_bet)}</td>
      <td data-label="Paid" class="mono">${fmt(r.total_paid)}</td>
      <td data-label="House" class="mono ${r.total_bet - r.total_paid >= 0 ? 'good' : 'bad'}">${fmt(r.total_bet - r.total_paid)}</td>
    </tr>`).join('') || '<tr><td colspan="7" class="muted">No rounds yet</td></tr>';
    tb.querySelectorAll('[data-r]').forEach((tr) => tr.addEventListener('click', () => openRound(Number(tr.dataset.r))));
  } else {
    const { bets } = await api(`/api/admin/bets?min=${rbTab === 'big' ? 100 : 0}`);
    const tb = $('betsTbl').querySelector('tbody');
    tb.innerHTML = bets.map((b) => `<tr>
      <td data-label="Player"><a class="link" href="#users" data-user="${b.user_id}">${esc(b.username)}</a></td>
      <td data-label="Round"><a class="link" href="#rounds" data-round="${b.round_id}">#${b.round_id}</a></td>
      <td data-label="Bet" class="mono">${fmt(b.amount)}</td>
      <td data-label="Auto" class="mono">${b.auto_cashout ? xs(b.auto_cashout) : '—'}</td>
      <td data-label="Cash-out" class="mono">${b.cashout_at ? xs(b.cashout_at) : '—'}</td>
      <td data-label="Payout" class="mono">${fmt(b.payout)}</td>
      <td data-label="Result"><span class="pill ${b.status === 'won' ? 'on' : b.status === 'lost' ? 'over' : ''}">${b.status}</span></td>
      <td data-label="When">${ago(b.created_at)}</td></tr>`).join('') || '<tr><td colspan="8" class="muted">No bets yet</td></tr>';
    tb.querySelectorAll('[data-user]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); openUser(Number(a.dataset.user)); }));
    tb.querySelectorAll('[data-round]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); openRound(Number(a.dataset.round)); }));
  }
}
async function openRound(id) {
  const { round: r, bets } = await api(`/api/admin/rounds/${id}`);
  $('drawerBody').innerHTML = `
    <div class="u-head"><span class="avatar lg">▲</span><div><h3>Round #${r.id}</h3>
      <div class="muted small">${r.ended_at ? date(r.ended_at) : r.status}</div></div></div>
    <div class="kvs">
      <div class="kv"><span>Crash point</span><b>${r.crash_point ? xs(r.crash_point) : 'secret until it ends'}</b></div>
      <div class="kv"><span>House edge used</span><b>${r.edge_pct}%</b></div>
      <div class="kv"><span>Total bet</span><b>${fmt(r.total_bet)}</b></div>
      <div class="kv"><span>House result</span><b class="${r.total_bet - r.total_paid >= 0 ? 'good' : 'bad'}">${fmt(r.total_bet - r.total_paid)}</b></div>
    </div>
    <div class="sub-card"><span class="muted small">Hash (shown before the round)</span><b class="mono small brk">${r.hash}</b>
      <span class="muted small">Seed (revealed after)</span><b class="mono small brk">${r.seed || '—'}</b></div>
    <h4>Bets (${bets.length})</h4>
    <div class="activity">${bets.map((b) => `<div class="act"><div class="act-ic">${esc(b.username[0].toUpperCase())}</div>
      <div><b>${esc(b.username)} · ${fmt(b.amount)}</b><div class="muted small">${b.status === 'won' ? `cashed out at ${xs(b.cashout_at)}` : b.status}${b.auto_cashout ? ` · auto ${xs(b.auto_cashout)}` : ''}</div></div>
      <div class="amt ${b.status === 'won' ? 'good' : 'bad'}">${b.status === 'won' ? fmt(b.payout) : b.status === 'lost' ? '−' + fmt(b.amount) : '0.00'}</div></div>`).join('') || '<p class="muted small">Nobody played this round</p>'}</div>`;
  $('drawer').classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}

// ---------- withdrawals ----------
let wdStatus = 'pending';
document.querySelectorAll('#wdFilter button').forEach((b) => b.addEventListener('click', () => {
  wdStatus = b.dataset.s; document.querySelectorAll('#wdFilter button').forEach((x) => x.classList.toggle('active', x === b)); loadWithdrawals();
}));
async function loadWithdrawals() {
  const { withdrawals } = await api(`/api/admin/withdrawals?status=${wdStatus}`);
  const tb = $('wdTbl').querySelector('tbody');
  tb.innerHTML = withdrawals.map((w) => `<tr>
    <td data-label="User"><a class="link" href="#users" data-user="${w.user_id}">${esc(w.username)}</a></td>
    <td data-label="Amount" class="mono"><b>${fmt(w.amount)}</b></td>
    <td data-label="Requested">${date(w.created_at)}</td>
    <td data-label="Balance now" class="mono">${fmt(w.balance)}</td>
    <td data-label="Note">${w.status === 'pending' ? `<input class="wd-note" data-note="${w.id}" placeholder="Optional note" />` : esc(w.admin_note || '—')}</td>
    <td data-label="">${w.status === 'pending'
      ? `<div class="row nowrap"><button class="btn primary small" data-ok="${w.id}">Approve</button><button class="btn ghost small" data-no="${w.id}">Reject</button></div>`
      : `<span class="pill ${w.status === 'approved' ? 'on' : 'over'}">${w.status}</span>`}</td>
  </tr>`).join('') || `<tr><td colspan="6" class="muted">No ${wdStatus} withdrawals</td></tr>`;
  const decide = async (id, approve) => {
    const note = tb.querySelector(`[data-note="${id}"]`)?.value || '';
    try { await api(`/api/admin/withdrawals/${id}`, { approve, note }); toast(approve ? 'Approved' : 'Rejected and refunded', 'good'); loadWithdrawals(); refreshBadges(); }
    catch (err) { toast(err.message, 'bad'); }
  };
  tb.querySelectorAll('[data-ok]').forEach((b) => b.addEventListener('click', () => decide(Number(b.dataset.ok), true)));
  tb.querySelectorAll('[data-no]').forEach((b) => b.addEventListener('click', () => decide(Number(b.dataset.no), false)));
  tb.querySelectorAll('[data-user]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); openUser(Number(a.dataset.user)); }));
}

// ---------- settings ----------
const GEN_FIELDS = ['houseEdgePct', 'minBet', 'maxBet', 'maxWin', 'maxMultiplier', 'bettingSeconds', 'pauseSeconds', 'signupBonus', 'referralSignupBonus', 'referralPct', 'minWithdraw'];
async function loadSettings() {
  const { settings } = await api('/api/admin/settings');
  const g = $('genForm');
  GEN_FIELDS.forEach((k) => (g.elements[k].value = settings[k]));
  g.elements.demoDeposits.checked = !!settings.demoDeposits;
  g.elements.gamePaused.checked = !!settings.gamePaused;
  g.elements.licenseText.value = settings.licenseText || '';
  edgeHelp();
}
function edgeHelp() {
  const e = Number($('genForm').elements.houseEdgePct.value), ref = Number($('genForm').elements.referralPct.value);
  $('edgeHelp').textContent = `With a ${e}% edge, players get back ${100 - e}% of what they bet on average, and the house keeps ${e}%. Referral rewards (${ref}% of each bet) come out of the house's ${e}%, so keep the referral % well below the edge.`;
}
['houseEdgePct', 'referralPct'].forEach((k) => $('genForm').elements[k].addEventListener('input', edgeHelp));
$('genForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const g = e.target;
  const body = { demoDeposits: g.elements.demoDeposits.checked, gamePaused: g.elements.gamePaused.checked, licenseText: g.elements.licenseText.value };
  GEN_FIELDS.forEach((k) => (body[k] = g.elements[k].value === '' ? '' : Number(g.elements[k].value)));
  try { await api('/api/admin/settings', body); toast('Settings saved. New numbers apply from the next round.', 'good'); cfg = await api('/api/config'); } catch (err) { toast(err.message, 'bad'); }
});

async function refreshBadges() { try { badges(await api('/api/admin/overview')); } catch {} }

// ---------- start ----------
(async () => {
  try {
    cfg = await api('/api/config');
    await api('/api/admin/settings'); // checks admin access
  } catch (e) {
    if (e.status === 403) { $('denied').classList.remove('hidden'); return; }
    return;
  }
  $('app').classList.remove('hidden');
  route();
  refreshBadges();
  setInterval(refreshBadges, 20000);
})();
