// Payment provider stub.
//
// Deposits and withdrawals only move VIRTUAL coins inside the app. No real money is handled.
// Withdrawals become requests that an admin approves or rejects in the admin dashboard.
//
// To take real money, connect a payment provider that is approved for licensed online
// gaming in Sri Lanka, here and nowhere else:
//   deposit()        -> create a payment with the provider; credit coins only from the
//                       provider's signed webhook, never from the browser.
//   decideWithdrawal -> on approve, send the payout through the provider's API.
// Also add identity checks (KYC) and age checks before the first real deposit.
const { db, tx } = require('./db');
const { addLedger, getUser, GameError } = require('./game');
const settings = require('./settings');

async function deposit(userId, amount, now = Date.now()) {
  if (!settings.get('demoDeposits')) throw new GameError('Deposits are not enabled yet');
  if (!(amount > 0 && amount <= 100000)) throw new GameError('Amount must be between 1 and 100000');
  if ((await getUser(userId)).break_until > now) throw new GameError("You're on a break. Deposits are paused until it ends");
  await tx(async () => {
    await db.run('UPDATE users SET balance = balance + ? WHERE id = ?', amount, userId);
    await addLedger(userId, 'deposit', amount, 'Demo deposit (virtual coins)', now);
  });
}

// Takes the coins off the balance now (held), and creates a pending request.
async function withdraw(userId, amount, now = Date.now()) {
  if (!(amount > 0)) throw new GameError('Amount must be positive');
  const min = settings.get('minWithdraw');
  if (amount < min) throw new GameError(`Minimum withdrawal is ${min}`);
  return tx(async () => {
    const user = await getUser(userId);
    if (user.balance < amount) throw new GameError('Not enough balance');
    if ((await db.get("SELECT COUNT(*) AS n FROM withdrawals WHERE user_id = ? AND status = 'pending'", userId)).n >= 3) {
      throw new GameError('You already have 3 pending withdrawals');
    }
    await db.run('UPDATE users SET balance = balance - ? WHERE id = ?', amount, userId);
    const lid = await addLedger(userId, 'withdraw', -amount, 'Withdrawal requested (waiting for admin)', now);
    await db.run('INSERT INTO withdrawals (user_id, amount, ledger_id, created_at) VALUES (?, ?, ?, ?)', userId, amount, lid, now);
  });
}

async function decideWithdrawal(adminId, id, approve, note = '', now = Date.now()) {
  return tx(async () => {
    const w = await db.get('SELECT * FROM withdrawals WHERE id = ?', id);
    if (!w) throw new GameError('Withdrawal not found');
    if (w.status !== 'pending') throw new GameError('Already decided');
    await db.run('UPDATE withdrawals SET status = ?, admin_note = ?, decided_at = ?, decided_by = ? WHERE id = ?', approve ? 'approved' : 'rejected', String(note).slice(0, 200) || null, now, adminId, id);
    if (approve) {
      await db.run('UPDATE ledger SET note = ? WHERE id = ?', 'Withdrawal approved (virtual, nothing paid out)', w.ledger_id);
    } else {
      await db.run('UPDATE users SET balance = balance + ? WHERE id = ?', w.amount, w.user_id);
      await addLedger(w.user_id, 'withdraw_refund', w.amount, `Withdrawal rejected${note ? `: ${String(note).slice(0, 100)}` : ''}`, now);
    }
  });
}

async function userWithdrawals(userId) {
  return db.all('SELECT id, amount, status, admin_note, created_at, decided_at FROM withdrawals WHERE user_id = ? ORDER BY id DESC LIMIT 20', userId);
}

module.exports = { deposit, withdraw, decideWithdrawal, userWithdrawals };
