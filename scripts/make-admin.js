// Usage: npm run make-admin -- <username>
const { db } = require('../src/db');
const name = process.argv[2];
if (!name) { console.log('Usage: npm run make-admin -- <username>'); process.exit(1); }
const r = db.prepare('UPDATE users SET is_admin = 1 WHERE username = ?').run(name);
console.log(r.changes ? `${name} is now an admin` : `No user called ${name}`);
