const { hashPassword } = require('../dist/services/auth.service');
const { db } = require('../dist/db');
const { users } = require('../dist/db/schema');
const { eq } = require('drizzle-orm');

async function main() {
  const username = (process.argv[2] || 'starfire').toLowerCase();
  const newPassword = process.argv[3] || 'e940529e';

  console.log(`Resetting password for user: ${username} ...`);
  const newHash = await hashPassword(newPassword);
  const res = db.update(users)
    .set({ passwordHash: newHash, updatedAt: Date.now() })
    .where(eq(users.username, username))
    .run();

  if (res.changes > 0) {
    console.log(`[SUCCESS] Password successfully reset for '${username}' to '${newPassword}'!`);
  } else {
    console.error(`[ERROR] User '${username}' not found in database.`);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
