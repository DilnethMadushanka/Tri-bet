const { DatabaseSync } = require('node:sqlite');
const { DB_PATH } = require('./config');

const db = new DatabaseSync(DB_PATH);
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL COLLATE NOCASE,
  email TEXT,
  password_hash TEXT NOT NULL,
  balance REAL NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_seen INTEGER,
  referral_code TEXT,
  referred_by INTEGER,
  is_admin INTEGER NOT NULL DEFAULT 0,
  is_banned INTEGER NOT NULL DEFAULT 0,
  break_until INTEGER NOT NULL DEFAULT 0,
  daily_bet_limit REAL NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS users_refcode ON users(referral_code);
CREATE INDEX IF NOT EXISTS users_referred_by ON users(referred_by);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);

-- Every balance change is a ledger line, so balance = sum of ledger.
CREATE TABLE IF NOT EXISTS ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,   -- signup_bonus | referral_signup | referral_bonus | deposit | withdraw | withdraw_refund | bet | win | bet_refund | admin_adjust | limit
  amount REAL NOT NULL, -- + adds to balance, - takes from balance
  note TEXT,
  round_id INTEGER,
  ref_user_id INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ledger_user ON ledger(user_id, id DESC);
CREATE INDEX IF NOT EXISTS ledger_type ON ledger(type, created_at);

CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS withdrawals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',   -- pending | approved | rejected
  ledger_id INTEGER,
  admin_note TEXT,
  created_at INTEGER NOT NULL,
  decided_at INTEGER,
  decided_by INTEGER
);
CREATE INDEX IF NOT EXISTS withdrawals_status ON withdrawals(status, id);

-- One row per crash round. seed is secret until the round ends; hash = sha256(seed) is public from the start.
CREATE TABLE IF NOT EXISTS rounds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hash TEXT NOT NULL,
  seed TEXT NOT NULL,
  crash_point REAL NOT NULL,
  edge_pct REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'betting',   -- betting | running | crashed | void
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  ended_at INTEGER,
  total_bet REAL NOT NULL DEFAULT 0,
  total_paid REAL NOT NULL DEFAULT 0,
  players INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS bets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  round_id INTEGER NOT NULL REFERENCES rounds(id),
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount REAL NOT NULL,
  auto_cashout REAL,                       -- null = manual only
  status TEXT NOT NULL DEFAULT 'active',   -- active | won | lost | refunded
  cashout_at REAL,                         -- multiplier the player cashed out at
  payout REAL NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS bets_round ON bets(round_id);
CREATE INDEX IF NOT EXISTS bets_user ON bets(user_id, id DESC);

-- Instant games (dice, mines, plinko, coin flip). Provably fair with a per-player seed pair.
CREATE TABLE IF NOT EXISTS seeds (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  server_seed TEXT NOT NULL,     -- secret until the player rotates it
  server_hash TEXT NOT NULL,     -- sha256(server_seed), shown to the player
  client_seed TEXT NOT NULL,     -- the player can change this
  nonce INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS revealed_seeds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  server_seed TEXT NOT NULL,
  server_hash TEXT NOT NULL,
  client_seed TEXT NOT NULL,
  last_nonce INTEGER NOT NULL,
  revealed_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS plays (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  game TEXT NOT NULL,                   -- dice | flip | plinko | mines
  amount REAL NOT NULL,
  payout REAL NOT NULL DEFAULT 0,
  multiplier REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL,                 -- active (mines in progress) | won | lost
  detail TEXT NOT NULL,                 -- JSON: the player's choices and the result
  server_hash TEXT NOT NULL,
  client_seed TEXT NOT NULL,
  nonce INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  ended_at INTEGER
);
CREATE INDEX IF NOT EXISTS plays_user ON plays(user_id, id DESC);
CREATE INDEX IF NOT EXISTS plays_time ON plays(created_at);
`);

function tx(fn) {
  if (db.isTransaction) return fn(); // already inside one: just run
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

module.exports = { db, tx };
