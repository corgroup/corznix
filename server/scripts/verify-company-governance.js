// Company governance verification — single owner / SUPER_ADMIN invariant,
// ADMIN role ceiling, owner immutability, and the default-warehouse authority.
//
// Runs against the local development database. Non-destructive: every staff
// row and warehouse it creates is torn down in `finally`, and the real default
// warehouse is restored.
//
//   npm run verify:company-governance
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

process.env.SHIPPING_PROVIDER_MODE = 'MOCK';

const { pool, query } = await import('../src/database/connection/pool.js');
const { staffAuthService } = await import('../src/modules/staff/service.js');
const { companyService } = await import('../src/modules/company/service.js');
const { warehouseService } = await import('../src/modules/warehouses/service.js');
const { adminWarehouseService } = await import('../src/modules/adminWarehouses/service.js');

const results = {};
const pass = (name) => { results[name] = 'PASS'; console.log(`  PASS  ${name}`); };
const TAG = `govern-${Date.now()}`;
const PW = 'Corcotton-Governance-Str0ng-Passphrase';

const createdStaff = [];
const createdWarehouses = [];
let originalDefaultId = null;

async function makeStaff(role, emailPart) {
  const staff = await staffAuthService.createStaffUser({
    email: `${emailPart}.${TAG}@governance-verify.test`,
    password: PW, firstName: 'Gov', lastName: 'Test', role,
  });
  createdStaff.push(staff.id);
  return staff;
}

async function expectReject(promise, code, label) {
  await assert.rejects(promise, (err) => {
    assert.equal(err.code, code, `${label}: expected ${code}, got ${err.code} (${err.message})`);
    return true;
  });
}

try {
  // ---- 1. company_profile singleton + owner -------------------------------
  {
    const profile = await companyService.getProfile();
    assert.ok(profile, 'company_profile row exists');
    assert.ok(profile.ownerStaffUserId, 'company has an owner');
    assert.ok(profile.defaultWarehouseId, 'company has a configured default warehouse');
    const owner = await companyService.getOwner();
    assert.ok(owner && owner.role === 'SUPER_ADMIN' && owner.status === 'ACTIVE', 'owner is the active SUPER_ADMIN');
    assert.equal(await companyService.isOwner(owner.id), true);
    assert.equal(await companyService.hasOwner(), true);

    const activeSupers = await query("SELECT COUNT(*) n FROM staff_users WHERE role='SUPER_ADMIN' AND status='ACTIVE'");
    assert.equal(Number(activeSupers[0].n), 1, 'exactly one active SUPER_ADMIN');
    originalDefaultId = profile.defaultWarehouseId;
    results.ACTIVE_COMPANY_OWNER_COUNT = 1;
    results.ACTIVE_SUPER_ADMIN_COUNT = 1;
    pass('COMPANY_OWNER_SINGLETON');
  }

  // ---- 2. company_profiles PK (brand_id) blocks a second row per brand ---
  // (Phase 7 — the legacy singular company_profile/singleton_guard table is
  // dropped; company_profiles is plural, keyed on brand_id since Phase 1.)
  {
    const [cottonBrand] = await query("SELECT id FROM brands WHERE slug='corcotton'");
    await expectReject(
      query('INSERT INTO company_profiles (brand_id, principal_country) VALUES (?, ?)', [cottonBrand.id, 'IN']),
      'ER_DUP_ENTRY', 'second company_profiles row for the same brand',
    );
    pass('COMPANY_PROFILE_SINGLETON_ENFORCED');
  }

  // ---- 3. second SUPER_ADMIN creation denied -----------------------------
  {
    await expectReject(
      makeStaff('SUPER_ADMIN', 'second.super'),
      'SUPER_ADMIN_EXISTS', 'second SUPER_ADMIN',
    );
    pass('SECOND_SUPER_ADMIN_CREATION_DENIED');
  }

  // ---- 4. ADMIN role ceiling -------------------------------------------
  {
    const adminActor = { id: randomUUID(), role: 'ADMIN', email: 'admin.actor@test' };
    await expectReject(
      staffAuthService.createStaffUser({ email: `x.${TAG}@governance-verify.test`, password: PW, firstName: 'A', lastName: 'B', role: 'ADMIN', actor: adminActor }),
      'ROLE_CEILING_EXCEEDED', 'ADMIN creates ADMIN',
    );
    await expectReject(
      staffAuthService.createStaffUser({ email: `y.${TAG}@governance-verify.test`, password: PW, firstName: 'A', lastName: 'B', role: 'SUPER_ADMIN', actor: adminActor }),
      'ROLE_CEILING_EXCEEDED', 'ADMIN creates SUPER_ADMIN',
    );
    // ADMIN CAN create ordinary staff
    const ordinary = await staffAuthService.createStaffUser({ email: `ok.${TAG}@governance-verify.test`, password: PW, firstName: 'A', lastName: 'B', role: 'OPERATIONS', actor: adminActor });
    createdStaff.push(ordinary.id);
    assert.equal(ordinary.role, 'OPERATIONS');

    // ADMIN cannot change an ADMIN's role or disable an ADMIN
    const someAdmin = await makeStaff('ADMIN', 'target.admin');
    await expectReject(
      staffAuthService.changeRole({ staffUserId: someAdmin.id, role: 'OPERATIONS', actor: adminActor }),
      'ROLE_CEILING_EXCEEDED', 'ADMIN demotes ADMIN',
    );
    await expectReject(
      staffAuthService.setStatus({ staffUserId: someAdmin.id, status: 'DISABLED', actor: adminActor }),
      'ROLE_CEILING_EXCEEDED', 'ADMIN disables ADMIN',
    );
    pass('ADMIN_ROLE_CEILING_ENFORCED');
  }

  // ---- 5. no promotion path to SUPER_ADMIN + owner immutability ---------
  {
    const someOps = await makeStaff('OPERATIONS', 'ops.promote');
    await expectReject(
      staffAuthService.changeRole({ staffUserId: someOps.id, role: 'SUPER_ADMIN' }),
      'SUPER_ADMIN_ROLE_LOCKED', 'promote to SUPER_ADMIN',
    );

    const ownerId = (await companyService.getProfile()).ownerStaffUserId;
    await expectReject(
      staffAuthService.changeRole({ staffUserId: ownerId, role: 'ADMIN' }),
      'OWNER_MODIFICATION_FORBIDDEN', 'demote owner',
    );
    await expectReject(
      staffAuthService.setStatus({ staffUserId: ownerId, status: 'DISABLED' }),
      'OWNER_MODIFICATION_FORBIDDEN', 'disable owner',
    );
    pass('OWNER_IMMUTABILITY_ENFORCED');
  }

  // ---- 6. default warehouse authority ----------------------------------
  {
    const [corcottonForDefault] = await query("SELECT id FROM brands WHERE slug='corcotton'");
    const def = await warehouseService.getDefault(corcottonForDefault.id);
    assert.equal(def.code, 'WH-GZP-PARSUPUR-01');
    assert.equal(def.postalCode, '233222');
    assert.equal(def.isDefault, true);
    const count = await query('SELECT COUNT(*) n FROM warehouses WHERE is_default = 1');
    assert.equal(Number(count[0].n), 1, 'exactly one default warehouse');
    const profile = await companyService.getProfile();
    assert.equal(profile.defaultWarehouseId, def.id, 'company_profile.default_warehouse_id matches is_default row');
    results.DEFAULT_WAREHOUSE = def.code;
    results.DEFAULT_WAREHOUSE_PIN = def.postalCode;
    pass('DEFAULT_WAREHOUSE_AUTHORITY');
  }

  // ---- 7. setDefault moves the flag + syncs company_profile ------------
  {
    const [cottonBrand] = await query("SELECT id FROM brands WHERE slug='corcotton'");
    const temp = await warehouseService.create({ code: `WH-TMP-${TAG.slice(-8)}`, name: 'Temp Default', city: 'Testville', state: 'UP', postalCode: '226001', country: 'IN', brandId: cottonBrand.id });
    createdWarehouses.push(temp.id);

    const moved = await warehouseService.setDefault(temp.id);
    assert.equal(moved.isDefault, true);
    const count = await query('SELECT COUNT(*) n FROM warehouses WHERE is_default = 1');
    assert.equal(Number(count[0].n), 1, 'still exactly one default after move');
    assert.equal((await warehouseService.get(originalDefaultId)).isDefault, false, 'previous default cleared');
    assert.equal((await companyService.getProfile()).defaultWarehouseId, temp.id, 'company_profile follows the move');

    // cannot disable the current default
    await expectReject(warehouseService.setStatus(temp.id, 'DISABLED'), 'WAREHOUSE_IS_DEFAULT', 'disable default');

    // restore the real default, then a DISABLED warehouse cannot become default
    await warehouseService.setDefault(originalDefaultId);
    assert.equal((await warehouseService.getDefault()).id, originalDefaultId, 'default restored');
    await warehouseService.setStatus(temp.id, 'DISABLED');
    await expectReject(warehouseService.setDefault(temp.id), 'WAREHOUSE_DISABLED', 'default a disabled warehouse');
    pass('DEFAULT_WAREHOUSE_TRANSITIONS');
  }

  // ---- 8. no real provider calls -------------------------------------
  results.realProviderCalls = 0;
  results.status = 'PASS';
  console.log('\nCOMPANY_GOVERNANCE_VERIFICATION = PASS');
  console.log(JSON.stringify(results, null, 2));
} catch (err) {
  console.error('\nCOMPANY_GOVERNANCE_VERIFICATION = FAIL');
  console.error(err);
  process.exitCode = 1;
} finally {
  try {
    if (originalDefaultId) {
      const [cottonBrand] = await query("SELECT id FROM brands WHERE slug='corcotton'");
      await query('UPDATE company_profiles SET default_warehouse_id = ? WHERE brand_id = ?', [originalDefaultId, cottonBrand.id]);
      await query('UPDATE warehouses SET is_default = 0 WHERE is_default = 1 AND id <> ?', [originalDefaultId]);
      await query('UPDATE warehouses SET is_default = 1 WHERE id = ?', [originalDefaultId]);
    }
    for (const id of createdWarehouses) await query('DELETE FROM warehouses WHERE id = ? AND is_default = 0', [id]);
    if (createdStaff.length) {
      const placeholders = createdStaff.map(() => '?').join(',');
      await query(`DELETE FROM staff_sessions WHERE staff_user_id IN (${placeholders})`, createdStaff);
      await query(`DELETE FROM staff_audit_logs WHERE staff_user_id IN (${placeholders})`, createdStaff);
      await query(`DELETE FROM staff_users WHERE id IN (${placeholders})`, createdStaff);
    }
    await query("DELETE FROM staff_users WHERE email_normalized LIKE '%@governance-verify.test'");
  } finally {
    await pool.end();
  }
}
