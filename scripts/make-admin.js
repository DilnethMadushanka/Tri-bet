// Usage: npm run make-admin -- <username>
// Uses the same database as the app (TURSO_DATABASE_URL / TURSO_AUTH_TOKEN, or the local file).
const { db, ready } = require('../src/db');
const name = process.argv[2];
if (!name) { console.log('Usage: npm run make-admin -- <username>'); process.exit(1); }
(async () => {
  await ready();
  const r = await db.run('UPDATE users SET is_admin = 1 WHERE username = ?', name);
  console.log(r.changes ? `${name} is now an admin` : `No user called ${name}`);
})().catch((e) => { console.error(e.message); process.exit(1); });
