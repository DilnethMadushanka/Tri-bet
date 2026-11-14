// Database: libSQL (SQLite-compatible).
//   - On Vercel: a hosted Turso database. Set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN.
//   - On your computer: a local file (DB_PATH, default data.sqlite). Nothing to set up.
//
// All calls are async. Inside tx(fn), every db call made by fn (and anything it calls) runs in
// the same write transaction, so balance changes are all-or-nothing.
const { createClient } = require('@libsql/client');
const { AsyncLocalStorage } = require('node:async_hooks');

const url = process.env.TURSO_DATABASE_URL || `file:${process.env.DB_PATH || 'data.sqlite'}`;
const client = createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN });
const als = new AsyncLocalStorage();

const SCHEMA = `
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
  id INTEGER PRIMARY KEY,                   -- previous id + 1, so two servers can't both start the next round
  hash TEXT NOT NULL,
  seed TEXT NOT NULL,
  crash_point REAL NOT NULL,
  edge_pct REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',      -- open | crashed (settled). Betting/running is worked out from the times.
  betting_ends_at INTEGER NOT NULL,          -- = start of the flight
  crash_at INTEGER NOT NULL,
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
CREATE UNIQUE INDEX IF NOT EXISTS bets_one_per_round ON bets(round_id, user_id) WHERE status != 'refunded';
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
`;

let readyP = null;
function ready() {
  if (!readyP) {
    readyP = client.executeMultiple(SCHEMA).catch((e) => { readyP = null; throw e; });
  }
  return readyP;
}

const plain = (rs) => rs.rows.map((row) => Object.fromEntries(rs.columns.map((c, i) => [c, row[i]])));
async function exec(sql, args) {
  await ready();
  const target = als.getStore() || client;
  return target.execute({ sql, args: args.map((a) => (a === undefined ? null : typeof a === 'boolean' ? (a ? 1 : 0) : a)) });
}

const db = {
  async get(sql, ...args) { return plain(await exec(sql, args))[0]; },
  async all(sql, ...args) { return plain(await exec(sql, args)); },
  async run(sql, ...args) {
    const rs = await exec(sql, args);
    return { changes: rs.rowsAffected, lastId: rs.lastInsertRowid === undefined ? undefined : Number(rs.lastInsertRowid) };
  },
};

// One write transaction at a time per server instance (the database also serialises writers).
let queue = Promise.resolve();
async function tx(fn) {
  if (als.getStore()) return fn(); // already inside one
  await ready();
  const run = async () => {
    const t = await client.transaction('write');
    try {
      const out = await als.run(t, fn);
      await t.commit();
      return out;
    } catch (e) {
      try { await t.rollback(); } catch {}
      throw e;
    } finally { t.close(); }
  };
  const p = queue.then(run, run);
  queue = p.catch(() => {});
  return p;
}

module.exports = { db, tx, ready, client };
