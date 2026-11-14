// Shared test setup: a fresh database file per test file.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'betdouble-test-'));
process.env.DB_PATH = path.join(dir, 'test.sqlite');
delete process.env.TURSO_DATABASE_URL;
const assert = require('node:assert');
const { db } = require('../src/db');
const game = require('../src/game');
const settings = require('../src/settings');

let n = 0;
const prefix = Math.random().toString(36).slice(2, 6);
module.exports = {
  db, game, settings,
  user: (opts = {}) => game.registerUser({ username: `${prefix}${++n}`, passwordHash: 'x', ...opts }),
  bal: async (id) => (await game.getUser(id)).balance,
  ledgerSum: async (id) => (await db.get('SELECT SUM(amount) AS s FROM ledger WHERE user_id = ?', id)).s,
  close: (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`),
  fund: async (id, amt) => { await db.run('UPDATE users SET balance = balance + ? WHERE id = ?', amt, id); await game.addLedger(id, 'deposit', amt, 'test'); },
  cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
};
