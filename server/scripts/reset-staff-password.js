// Reset an existing staff member's password. Operational tooling (root /
// shell only) — parallel to staff:create, not an in-app feature.
//
//   npm run staff:password -- --email admin@corcotton.in
//
// Password input: --password-stdin | STAFF_INITIAL_PASSWORD env | masked
// prompt (asked twice). Same scrypt hashing + >=12-char policy as
// staff:create. On success every live session for that account is revoked
// (forces re-login). The password is never printed or logged.
import { staffAuthService } from '../src/modules/staff/service.js';
import { pool } from '../src/database/connection/pool.js';
import { parseArgs, resolvePassword } from './lib/passwordInput.js';

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const email = args.email;
  if (!email) {
    throw new Error('Required: --email <staff email>.');
  }

  const password = await resolvePassword(args, { prompt: 'New password: ' });

  const staff = await staffAuthService.resetPassword({ email, newPassword: password });

  console.log(`Password reset for:`);
  console.log(`  email:  ${staff.email}`);
  console.log(`  role:   ${staff.role}`);
  console.log(`  status: ${staff.status}`);
  console.log(`  (all existing sessions for this account were revoked)`);
}

main()
  .then(() => pool.end())
  .catch(async (err) => {
    console.error(`\nstaff:password failed — ${err.message}\n`);
    process.exitCode = 1;
    await pool.end().catch(() => {});
  });
