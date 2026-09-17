// Secure bootstrap / provisioning for staff accounts.
//
//   npm run staff:create -- --email ops@corcotton.in --first-name Asha --last-name Rao [--role SUPER_ADMIN]
//
// Password input, in order of precedence:
//   1. --password-stdin        read one line from stdin (for pipelines / CI)
//   2. STAFF_INITIAL_PASSWORD  environment variable (never echoed)
//   3. interactive masked prompt (TTY only), asked twice
//
// Guarantees: no hardcoded/default password, no password ever printed or
// logged, duplicate-email rejection, invalid-email rejection, weak-password
// rejection. No admin account is auto-created — this must be run explicitly.
import { staffAuthService } from '../src/modules/staff/service.js';
import { STAFF_ROLES } from '../src/modules/staff/permissions.js';
import { pool } from '../src/database/connection/pool.js';
import { parseArgs, resolvePassword } from './lib/passwordInput.js';

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const email = args.email;
  const firstName = args['first-name'];
  const lastName = args['last-name'];
  const role = (args.role || 'SUPER_ADMIN').toUpperCase();

  if (!email || !firstName || !lastName) {
    throw new Error('Required: --email, --first-name, --last-name (optional: --role, default SUPER_ADMIN).');
  }
  if (!STAFF_ROLES.includes(role)) {
    throw new Error(`--role must be one of: ${STAFF_ROLES.join(', ')}.`);
  }

  const password = await resolvePassword(args);
  // The `--no-force-change` flag keeps the password as-is (e.g. seeding a
  // known test account); by default a CLI-provisioned account must set its
  // own password on first login.
  const forceChange = !('no-force-change' in args) && role !== 'SUPER_ADMIN';

  const staff = await staffAuthService.createStaffUser({ email, password, firstName, lastName, role, mustChangePassword: forceChange });

  // Never print the password. Identity + role only.
  console.log(`Created staff user:`);
  console.log(`  id:    ${staff.id}`);
  console.log(`  email: ${staff.email}`);
  console.log(`  name:  ${staff.first_name} ${staff.last_name}`);
  console.log(`  role:  ${staff.role}`);
  if (forceChange) console.log(`  note:  temporary password — the user must set their own on first login.`);
  console.log(`  status:${staff.status}`);
}

main()
  .then(() => pool.end())
  .catch(async (err) => {
    console.error(`\nstaff:create failed — ${err.message}\n`);
    process.exitCode = 1;
    await pool.end().catch(() => {});
  });
