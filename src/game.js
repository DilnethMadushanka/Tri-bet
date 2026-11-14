// Accounts, ledger, referrals, responsible play and the per-user state the app shows.
const crypto = require('node:crypto');
const { db, tx } = require('./db');
const settings = require('./settings');

class GameError extends Error {}

const round2 = (n) => Math.floor(n * 100 + 1e-7) / 100;

function addLedger(userId, type, amount, note, now = Date.now(), extra = {}) {
  const r = db
    .prepare('INSERT INTO ledger (user_id, type, amount, note, round_id, ref_user_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(userId, type, amount, note, extra.roundId ?? null, extra.refUserId ?? null, now);
  return Number(r.lastInsertRowid);
}

function getUser(userId) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
}

function credit(userId, amount, type, note, now = Date.now(), extra = {}) {
  db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').run(amount, userId);
  return addLedger(userId, type, amount, note, now, extra);
}

// Coins bet in the last 24 hours (refunded bets don't count).
function betLast24h(userId, now = Date.now()) {
  const since = now - 86400000;
  return db.prepare("SELECT COALESCE(SUM(amount), 0) AS s FROM bets WHERE user_id = ? AND status != 'refunded' AND created_at >= ?").get(userId, since).s
    + db.prepare('SELECT COALESCE(SUM(amount), 0) AS s FROM plays WHERE user_id = ? AND created_at >= ?').get(userId, since).s;
}

// Throws if this user may not bet this amount right now (break, 24h limit).
function checkCanBet(user, amount, now = Date.now()) {
  if (user.break_until > now) throw new GameError(`You're on a break until ${new Date(user.break_until).toLocaleString()}`);
  if (user.daily_bet_limit > 0) {
    const used = betLast24h(user.id, now);
    if (used + amount > user.daily_bet_limit + 1e-9) {
      throw new GameError(`That goes over your 24-hour bet limit of ${user.daily_bet_limit}. Used so far: ${round2(used)}`);
    }
  }
}

function setPlay(userId, { breakDays, dailyBetLimit }, now = Date.now()) {
  if (dailyBetLimit !== undefined) {
    const lim = Number(dailyBetLimit);
    if (!Number.isFinite(lim) || lim < 0) throw new GameError('Limit must be 0 (no limit) or more');
    db.prepare('UPDATE users SET daily_bet_limit = ? WHERE id = ?').run(lim, userId);
    addLedger(userId, 'limit', 0, lim ? `24-hour bet limit set to ${lim}` : 'Bet limit removed', now);
  }
  if (breakDays !== undefined) {
    const d = Number(breakDays);
    if (![1, 7, 30].includes(d)) throw new GameError('Choose 1, 7 or 30 days');
    db.prepare('UPDATE users SET break_until = ? WHERE id = ?').run(now + d * 86400000, userId);
    addLedger(userId, 'limit', 0, `Took a ${d}-day break. Betting and deposits paused`, now);
  }
}

function publicUser(u) {
  return {
    id: u.id, username: u.username, email: u.email, balance: u.balance, createdAt: u.created_at,
    referralCode: u.referral_code, isAdmin: !!u.is_admin, breakUntil: u.break_until, dailyBetLimit: u.daily_bet_limit,
  };
}

// ---------- accounts & referrals ----------
function newReferralCode() {
  for (;;) {
    const code = crypto.randomBytes(4).toString('hex').toUpperCase();
    if (!db.prepare('SELECT 1 FROM users WHERE referral_code = ?').get(code)) return code;
  }
}

function registerUser({ username, email, passwordHash, referralCode }, now = Date.now()) {
  return tx(() => {
    let inviter = null;
    if (referralCode) {
      inviter = db.prepare('SELECT id, is_banned FROM users WHERE referral_code = ?').get(String(referralCode).trim().toUpperCase());
      if (!inviter || inviter.is_banned) throw new GameError('That invite code is not valid');
    }
    const isFirst = db.prepare('SELECT COUNT(*) AS n FROM users').get().n === 0;
    const adminName = process.env.ADMIN_USERNAME;
    const isAdmin = isFirst || (adminName && adminName.toLowerCase() === username.toLowerCase()) ? 1 : 0;
    const r = db.prepare('INSERT INTO users (username, email, password_hash, balance, created_at, referral_code, referred_by, is_admin) VALUES (?, ?, ?, 0, ?, ?, ?, ?)')
      .run(username, email || null, passwordHash, now, newReferralCode(), inviter ? inviter.id : null, isAdmin);
    const id = Number(r.lastInsertRowid);
    const bonus = settings.get('signupBonus');
    if (bonus > 0) credit(id, bonus, 'signup_bonus', 'Welcome bonus', now);
    const refBonus = settings.get('referralSignupBonus');
    if (inviter && refBonus > 0) credit(id, refBonus, 'referral_signup', 'Bonus for joining with an invite', now);
    return id;
  });
}

// Pays the inviter referralPct% of a bet that was actually played. Call inside a tx.
function payReferral(bet, player, now) {
  const pct = settings.get('referralPct');
  if (!player.referred_by || !(pct > 0)) return;
  const inviter = getUser(player.referred_by);
  if (!inviter || inviter.is_banned) return;
  const bonus = Math.round(bet.amount * pct * 100) / 10000; // amount * pct / 100, to 2 decimals
  if (bonus < 0.01) return;
  credit(inviter.id, bonus, 'referral_bonus', `${player.username} played a ${bet.amount} bet (${pct}%)`, now, { refUserId: player.id, roundId: bet.round_id });
}

function referralStats(userId) {
  const people = db.prepare(`
    SELECT u.id, u.username, u.created_at,
      (SELECT COUNT(*) FROM bets WHERE user_id = u.id AND status != 'refunded') + (SELECT COUNT(*) FROM plays WHERE user_id = u.id) AS bets,
      (SELECT COALESCE(SUM(amount), 0) FROM ledger WHERE user_id = ? AND type = 'referral_bonus' AND ref_user_id = u.id) AS earned
    FROM users u WHERE u.referred_by = ? ORDER BY u.id DESC LIMIT 200`).all(userId, userId);
  const earned = db.prepare("SELECT COALESCE(SUM(amount), 0) AS s FROM ledger WHERE user_id = ? AND type = 'referral_bonus'").get(userId).s;
  return {
    code: getUser(userId).referral_code,
    pct: settings.get('referralPct'),
    signupBonus: settings.get('referralSignupBonus'),
    count: people.length,
    activeCount: people.filter((p) => p.bets > 0).length,
    earned,
    people: people.map((p) => ({ username: p.username, joinedAt: p.created_at, bets: p.bets, earnedFrom: p.earned })),
  };
}

function myBets(userId, limit = 30) {
  return db.prepare(`SELECT b.id, b.round_id, b.amount, b.auto_cashout, b.status, b.cashout_at, b.payout, b.created_at,
      CASE WHEN r.status = 'crashed' THEN r.crash_point END AS crash_point
    FROM bets b JOIN rounds r ON r.id = b.round_id WHERE b.user_id = ? ORDER BY b.id DESC LIMIT ?`).all(userId, limit);
}

function state(userId, now = Date.now()) {
  const user = getUser(userId);
  const ledger = db.prepare('SELECT id, type, amount, note, round_id, created_at FROM ledger WHERE user_id = ? ORDER BY id DESC LIMIT 60').all(userId);
  const totals = db.prepare(`SELECT COUNT(*) AS bets, COALESCE(SUM(amount), 0) AS wagered, COALESCE(SUM(payout), 0) AS won,
      COALESCE(MAX(cashout_at), 0) AS best FROM bets WHERE user_id = ? AND status IN ('won', 'lost')`).get(userId);
  const pt = db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS w, COALESCE(SUM(payout), 0) AS p, COALESCE(MAX(multiplier), 0) AS best FROM plays WHERE user_id = ? AND status != 'active'").get(userId);
  totals.bets += pt.n; totals.wagered += pt.w; totals.won += pt.p; totals.best = Math.max(totals.best, pt.best);
  return {
    now,
    user: publicUser(user),
    ledger,
    bets: myBets(userId),
    totals: { ...totals, used24h: betLast24h(userId, now) },
    referrals: referralStats(userId),
  };
}

module.exports = { GameError, round2, addLedger, getUser, credit, checkCanBet, betLast24h, setPlay, publicUser, registerUser, payReferral, referralStats, myBets, state };
