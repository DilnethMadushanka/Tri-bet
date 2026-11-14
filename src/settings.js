// Admin-editable settings, stored in the database.
const { db } = require('./db');
const config = require('./config');

const DEFAULTS = {
  signupBonus: config.SIGNUP_BONUS,
  referralSignupBonus: 50,  // extra coins for a new user who signs up with an invite link
  referralPct: 0.5,         // % of every bet a friend places, paid to the inviter (one level only)
  demoDeposits: config.DEMO_DEPOSITS,
  minWithdraw: 10,
  licenseText: 'BetDouble · Licence No. SL-3289CB',
  // Crash game
  houseEdgePct: 3,          // expected house profit per bet. Players get back (100 - edge)% on average.
  minBet: 1,
  maxBet: 1000,
  maxWin: 50000,            // a single bet's payout is capped here (auto cash-out when reached)
  maxMultiplier: 1000,      // the rocket never flies past this
  bettingSeconds: 7,        // time to place bets before each round
  pauseSeconds: 3,          // pause after a crash before the next betting window
  gamePaused: false,        // admin switch: finish the current round, then start no new ones
};

let cache = null;
function all() {
  if (!cache) {
    cache = { ...DEFAULTS };
    for (const r of db.prepare('SELECT key, value FROM settings').all()) {
      try { if (r.key in DEFAULTS) cache[r.key] = JSON.parse(r.value); } catch {}
    }
  }
  return cache;
}
const get = (k) => all()[k];

class SettingsError extends Error {}
const num = (v, min, max, name) => {
  const n = Number(v);
  if (v === '' || v === null || !Number.isFinite(n) || n < min || n > max) throw new SettingsError(`${name} must be between ${min} and ${max}`);
  return n;
};

const RULES = {
  signupBonus: [0, 1e6, 'Welcome bonus'],
  referralSignupBonus: [0, 1e6, 'Invite bonus'],
  referralPct: [0, 5, 'Referral %'],
  minWithdraw: [0, 1e9, 'Minimum withdrawal'],
  houseEdgePct: [0, 20, 'House edge %'],
  minBet: [0.01, 1e6, 'Minimum bet'],
  maxBet: [0.01, 1e9, 'Maximum bet'],
  maxWin: [1, 1e10, 'Maximum win'],
  maxMultiplier: [2, 1e6, 'Maximum multiplier'],
  bettingSeconds: [3, 60, 'Betting time'],
  pauseSeconds: [1, 30, 'Pause after crash'],
};

function update(patch) {
  const clean = {};
  for (const [k, [min, max, name]] of Object.entries(RULES)) if (k in patch) clean[k] = num(patch[k], min, max, name);
  if ('gamePaused' in patch) clean.gamePaused = !!patch.gamePaused;
  if ('demoDeposits' in patch) clean.demoDeposits = !!patch.demoDeposits;
  if ('licenseText' in patch) clean.licenseText = String(patch.licenseText || '').slice(0, 200);
  const merged = { ...all(), ...clean };
  if (merged.minBet > merged.maxBet) throw new SettingsError('Minimum bet must not be more than maximum bet');
  if (merged.maxBet > merged.maxWin) throw new SettingsError('Maximum bet must not be more than maximum win');
  const up = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  for (const [k, v] of Object.entries(clean)) up.run(k, JSON.stringify(v));
  cache = null;
  return all();
}

module.exports = { all, get, update, DEFAULTS, SettingsError };
