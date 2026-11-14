// Admin API. Every route here requires an admin session (see requireAdmin in server.js).
const express = require('express');
const { db, tx } = require('./db');
const game = require('./game');
const payments = require('./payments');
const settings = require('./settings');
const { crash } = require('./crash');
const instant = require('./instant');

const r = express.Router();

const handle = (fn) => (req, res) => {
  try {
    res.json({ ok: true, ...(fn(req) || {}) });
  } catch (e) {
    if (e instanceof game.GameError || e instanceof settings.SettingsError) {
      return res.status(400).json({ error: e.message });
    }
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
};

const sum = (sql, ...a) => db.prepare(sql).get(...a).s || 0;
const count = (sql, ...a) => db.prepare(sql).get(...a).n;

r.get('/overview', handle(() => {
  const now = Date.now();
  const day = 86400000;
  const since = now - 14 * day;
  const rounds = db.prepare("SELECT ended_at, total_bet, total_paid, players FROM rounds WHERE status = 'crashed' AND ended_at >= ?").all(since);
  const signups = db.prepare('SELECT created_at FROM users WHERE created_at >= ?').all(since);
  const plays = db.prepare("SELECT created_at, amount, payout FROM plays WHERE status != 'active' AND created_at >= ?").all(since);
  const days = [];
  for (let i = 13; i >= 0; i--) {
    const start = new Date(now - i * day); start.setHours(0, 0, 0, 0);
    const s = start.getTime(), e = s + day;
    const rs = rounds.filter((x) => x.ended_at >= s && x.ended_at < e);
    const ps = plays.filter((x) => x.created_at >= s && x.created_at < e);
    const bet = rs.reduce((a, x) => a + x.total_bet, 0) + ps.reduce((a, x) => a + x.amount, 0);
    const paid = rs.reduce((a, x) => a + x.total_paid, 0) + ps.reduce((a, x) => a + x.payout, 0);
    days.push({ day: s, signups: signups.filter((u) => u.created_at >= s && u.created_at < e).length, wagered: bet, profit: bet - paid });
  }
  const t = db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(total_bet), 0) AS bet, COALESCE(SUM(total_paid), 0) AS paid FROM rounds WHERE status = 'crashed'").get();
  const td = db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(total_bet), 0) AS bet, COALESCE(SUM(total_paid), 0) AS paid FROM rounds WHERE status = 'crashed' AND ended_at >= ?").get(now - day);
  const pAll = db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS bet, COALESCE(SUM(payout), 0) AS paid FROM plays WHERE status != 'active'").get();
  const pDay = db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS bet, COALESCE(SUM(payout), 0) AS paid FROM plays WHERE status != 'active' AND created_at >= ?").get(now - day);
  const byGame = [{ game: 'crash', name: 'Crash', bets: count("SELECT COUNT(*) AS n FROM bets WHERE status IN ('won', 'lost')"), wagered: t.bet, paid: t.paid }]
    .concat(db.prepare("SELECT game, COUNT(*) AS bets, SUM(amount) AS wagered, SUM(payout) AS paid FROM plays WHERE status != 'active' GROUP BY game").all()
      .map((g) => ({ ...g, name: instant.GAMES[g.game] || g.game })));
  const W = t.bet + pAll.bet, P = t.paid + pAll.paid;
  return {
    users: count('SELECT COUNT(*) AS n FROM users'),
    usersToday: count('SELECT COUNT(*) AS n FROM users WHERE created_at >= ?', now - day),
    activeToday: count('SELECT COUNT(*) AS n FROM users WHERE last_seen >= ?', now - day),
    playersToday: count("SELECT COUNT(*) AS n FROM (SELECT user_id FROM bets WHERE created_at >= ? AND status != 'refunded' UNION SELECT user_id FROM plays WHERE created_at >= ?)", now - day, now - day),
    banned: count('SELECT COUNT(*) AS n FROM users WHERE is_banned = 1'),
    totalBalances: sum('SELECT SUM(balance) AS s FROM users'),
    rounds: t.n, wagered: W, paid: P, profit: W - P, byGame, betsCount: byGame.reduce((a, g) => a + g.bets, 0),
    roundsToday: td.n, betsToday: td.n + pDay.n, wageredToday: td.bet + pDay.bet, profitToday: td.bet + pDay.bet - td.paid - pDay.paid,
    rtp: W > 0 ? (P / W) * 100 : null,
    houseEdgePct: settings.get('houseEdgePct'),
    deposits: sum("SELECT SUM(amount) AS s FROM ledger WHERE type = 'deposit'"),
    withdrawalsApproved: sum("SELECT SUM(amount) AS s FROM withdrawals WHERE status = 'approved'"),
    withdrawalsPending: count("SELECT COUNT(*) AS n FROM withdrawals WHERE status = 'pending'"),
    withdrawalsPendingAmount: sum("SELECT SUM(amount) AS s FROM withdrawals WHERE status = 'pending'"),
    referralPaid: sum("SELECT SUM(amount) AS s FROM ledger WHERE type IN ('referral_bonus', 'referral_signup')"),
    bonusesPaid: sum("SELECT SUM(amount) AS s FROM ledger WHERE type = 'signup_bonus'"),
    live: crash.publicState(),
    days,
  };
}));

r.get('/rounds', handle(() => ({
  rounds: db.prepare(`SELECT id, hash, crash_point, status, started_at, ended_at, players, total_bet, total_paid FROM rounds
    WHERE status IN ('crashed', 'void') ORDER BY id DESC LIMIT 200`).all(),
})));
r.get('/rounds/:id', handle((req) => {
  const round = db.prepare('SELECT * FROM rounds WHERE id = ?').get(Number(req.params.id));
  if (!round) throw new game.GameError('Round not found');
  if (round.status === 'betting' || round.status === 'running') { round.seed = null; round.crash_point = null; } // secret until it ends, even for admins
  const bets = db.prepare('SELECT b.*, u.username FROM bets b JOIN users u ON u.id = b.user_id WHERE b.round_id = ? ORDER BY b.payout DESC, b.amount DESC').all(round.id);
  return { round, bets };
}));

r.get('/plays', handle((req) => {
  const g = String(req.query.game || '');
  return { plays: db.prepare(`SELECT p.id, p.game, p.amount, p.payout, p.multiplier, p.status, p.created_at, u.username, u.id AS user_id
    FROM plays p JOIN users u ON u.id = p.user_id WHERE (? = '' OR p.game = ?) ORDER BY p.id DESC LIMIT 300`).all(g, g) };
}));

r.get('/bets', handle((req) => {
  const big = Number(req.query.min || 0);
  return { bets: db.prepare(`SELECT b.id, b.round_id, b.amount, b.auto_cashout, b.status, b.cashout_at, b.payout, b.created_at, u.username, u.id AS user_id
    FROM bets b JOIN users u ON u.id = b.user_id WHERE b.amount >= ? AND b.status != 'active' ORDER BY b.id DESC LIMIT 300`).all(big) };
}));

r.get('/users', handle((req) => {
  const q = `%${String(req.query.q || '').trim()}%`;
  const users = db.prepare(`
    SELECT u.id, u.username, u.email, u.balance, u.created_at, u.last_seen, u.is_admin, u.is_banned, u.referral_code,
      inv.username AS invited_by,
      (SELECT COUNT(*) FROM bets WHERE user_id = u.id AND status IN ('won', 'lost')) + (SELECT COUNT(*) FROM plays WHERE user_id = u.id AND status != 'active') AS bets,
      (SELECT COALESCE(SUM(amount - payout), 0) FROM bets WHERE user_id = u.id AND status IN ('won', 'lost'))
        + (SELECT COALESCE(SUM(amount - payout), 0) FROM plays WHERE user_id = u.id AND status != 'active') AS house_profit,
      (SELECT COUNT(*) FROM users x WHERE x.referred_by = u.id) AS referrals
    FROM users u LEFT JOIN users inv ON inv.id = u.referred_by
    WHERE u.username LIKE ? OR IFNULL(u.email, '') LIKE ? OR u.referral_code LIKE ?
    ORDER BY u.id DESC LIMIT 300`).all(q, q, q);
  return { users };
}));

r.get('/users/:id', handle((req) => {
  const id = Number(req.params.id);
  const user = db.prepare(`SELECT u.*, inv.username AS invited_by FROM users u LEFT JOIN users inv ON inv.id = u.referred_by WHERE u.id = ?`).get(id);
  if (!user) throw new game.GameError('User not found');
  delete user.password_hash;
  const bets = db.prepare('SELECT id, round_id, amount, auto_cashout, status, cashout_at, payout, created_at FROM bets WHERE user_id = ? ORDER BY id DESC LIMIT 100').all(id);
  const totals = db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS bet, COALESCE(SUM(payout), 0) AS paid FROM bets WHERE user_id = ? AND status IN ('won', 'lost')").get(id);
  const pt = db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS bet, COALESCE(SUM(payout), 0) AS paid FROM plays WHERE user_id = ? AND status != 'active'").get(id);
  totals.n += pt.n; totals.bet += pt.bet; totals.paid += pt.paid;
  const plays = db.prepare("SELECT id, game, amount, payout, multiplier, status, created_at FROM plays WHERE user_id = ? ORDER BY id DESC LIMIT 60").all(id);
  const ledger = db.prepare('SELECT id, type, amount, note, created_at FROM ledger WHERE user_id = ? ORDER BY id DESC LIMIT 100').all(id);
  const referrals = db.prepare('SELECT id, username, created_at FROM users WHERE referred_by = ? ORDER BY id DESC').all(id);
  return { user, bets, plays, totals, ledger, referrals };
}));

r.post('/users/:id/adjust', handle((req) => {
  const id = Number(req.params.id);
  const amount = Number(req.body.amount);
  const note = String(req.body.note || '').trim().slice(0, 120);
  if (!Number.isFinite(amount) || amount === 0) throw new game.GameError('Enter a non-zero amount');
  if (!note) throw new game.GameError('Add a reason');
  tx(() => {
    const u = game.getUser(id);
    if (!u) throw new game.GameError('User not found');
    if (u.balance + amount < 0) throw new game.GameError('Balance would go below zero');
    db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').run(amount, id);
    game.addLedger(id, 'admin_adjust', amount, `Admin: ${note}`);
  });
}));

r.post('/users/:id/ban', handle((req) => {
  const id = Number(req.params.id);
  if (id === req.userId) throw new game.GameError("You can't ban yourself");
  const banned = req.body.banned ? 1 : 0;
  db.prepare('UPDATE users SET is_banned = ? WHERE id = ?').run(banned, id);
  if (banned) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
}));

r.post('/users/:id/admin', handle((req) => {
  const id = Number(req.params.id);
  if (id === req.userId && !req.body.admin) throw new game.GameError("You can't remove your own admin rights");
  db.prepare('UPDATE users SET is_admin = ? WHERE id = ?').run(req.body.admin ? 1 : 0, id);
}));

r.get('/withdrawals', handle((req) => {
  const status = ['pending', 'approved', 'rejected'].includes(req.query.status) ? req.query.status : 'pending';
  const rows = db.prepare(`SELECT w.*, u.username, u.balance FROM withdrawals w JOIN users u ON u.id = w.user_id WHERE w.status = ? ORDER BY w.id DESC LIMIT 300`).all(status);
  return { withdrawals: rows };
}));

r.post('/withdrawals/:id', handle((req) => {
  payments.decideWithdrawal(req.userId, Number(req.params.id), !!req.body.approve, req.body.note || '');
}));


r.get('/settings', handle(() => ({ settings: settings.all() })));
r.post('/settings', handle((req) => ({ settings: settings.update(req.body || {}) })));

let hasher = null;
r.setPasswordHasher = (fn) => { hasher = fn; };
r.post('/users/:id/password', handle((req) => {
  const pw = String(req.body.password || '');
  if (pw.length < 8) throw new game.GameError('Password must be at least 8 characters');
  const id = Number(req.params.id);
  const c = db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hasher(pw), id).changes;
  if (!c) throw new game.GameError('User not found');
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
}));

module.exports = r;
