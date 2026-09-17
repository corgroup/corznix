import { env } from '../../config/index.js';
import { query as dbQuery } from '../../database/connection/pool.js';
import { logger } from '../../utils/logger.js';
import { fetchPostalRecords } from './dataGovClient.js';
import { normalizeRecord, resolveStateCode } from './stateNames.js';

const log = logger('postal');

// Six digits, first one 1-9: the first digit is the postal zone and there is
// no zone 0. This is the only case where "invalid" is a certainty. A PIN the
// directory simply has no record of is reported as NOT_FOUND — "could not
// verify" — never as invalid, because a missing record is not proof.
export const PIN_FORMAT = /^[1-9]\d{5}$/;

// Enough for the largest real PINs; a guard against paging forever on a
// misbehaving reply, not a cap anyone should hit.
const MAX_LIVE_PAGES = 5;

const cut = (value, length) => (value == null ? null : String(value).slice(0, length));

export class PostalService {
  constructor({
    query = dbQuery,
    fetchRecords = fetchPostalRecords,
    isConfigured = () => Boolean(env.DATA_GOV_IN_API_KEY),
    hasDirectory = null,
    resourceId = env.POSTAL_DIRECTORY_RESOURCE_ID,
  } = {}) {
    this.query = query;
    this.fetchRecords = fetchRecords;
    this.isConfigured = isConfigured;
    this.hasDirectoryOverride = hasDirectory;
    this.resourceId = resourceId;
    this.statesCache = null;
  }

  async states() {
    if (!this.statesCache) this.statesCache = await this.query('SELECT code, name FROM geo_states');
    return this.statesCache;
  }

  // Whether the local table is the WHOLE directory. Rows alone do not prove
  // that: a single-PIN sync, a bounded trial run or a cached live lookup leaves
  // rows behind that say nothing about the PINs they did not fetch. Only a
  // finished full sync of the resource we read makes "not in the table" mean
  // "not in the directory".
  async hasDirectory() {
    if (this.hasDirectoryOverride) return this.hasDirectoryOverride();
    const rows = await this.query(
      `SELECT 1 AS present FROM postal_directory_syncs
        WHERE resource_id = ? AND scope = 'FULL' AND status = 'SUCCEEDED' LIMIT 1`,
      [this.resourceId]);
    return rows.length > 0;
  }

  async lookup(rawPin) {
    const pincode = String(rawPin ?? '').trim();
    if (!PIN_FORMAT.test(pincode)) return { status: 'INVALID', reason: 'FORMAT', pincode };

    const stored = await this.query(
      `SELECT office_name, office_type, delivery, district, state_code
         FROM postal_offices WHERE pincode = ?
        ORDER BY (delivery = 'Delivery') DESC, office_name`,
      [pincode]);
    if (stored.length) return this.found(pincode, stored.map(fromRow), 'DIRECTORY');

    if (this.isConfigured()) return this.lookupLive(pincode);

    // No key. After a complete sync the table is the whole directory as of
    // that sync, so an absent PIN is "not found". Without one, nothing can be
    // said about a PIN we hold no rows for, and the form works manually.
    if (await this.hasDirectory()) return { status: 'NOT_FOUND', pincode, source: 'DIRECTORY' };
    return { status: 'UNAVAILABLE', reason: 'NOT_CONFIGURED', pincode };
  }

  async lookupLive(pincode) {
    const collected = [];
    let offset = 0;
    let total = null;
    try {
      for (let page = 0; page < MAX_LIVE_PAGES; page += 1) {
        const reply = await this.fetchRecords({ filters: { pincode }, offset, limit: 100 });
        total = reply.total;
        // Advance by what arrived, not by what survived filtering — otherwise
        // a record for some other PIN would stall the offset.
        offset += reply.records.length;
        collected.push(...reply.records.map(normalizeRecord).filter((r) => r.pincode === pincode && r.officeName));
        if (reply.records.length === 0 || offset >= total) break;
      }
    } catch (error) {
      log.warn('postal_live_lookup_unavailable', { pincode, kind: error?.kind || 'UNKNOWN' });
      return { status: 'UNAVAILABLE', reason: error?.kind || 'UNKNOWN', pincode };
    }

    if (!collected.length) return { status: 'NOT_FOUND', pincode, source: 'LIVE' };

    const states = await this.states();
    const offices = collected.map((r) => ({ ...r, stateCode: resolveStateCode(r.stateName, states) }));
    // Caching is a convenience. A failed write must not turn a successful
    // lookup into a failure — but it is logged, not swallowed.
    await this.upsertOffices(offices, 'LIVE').catch((error) => {
      log.warn('postal_live_cache_failed', { pincode, message: error?.message });
    });
    const result = await this.found(pincode, offices, 'LIVE');
    // Fewer offices than the directory says exist: say so rather than present
    // a partial list as the whole.
    if (total !== null && collected.length < total) result.complete = false;
    return result;
  }

  async found(pincode, offices, source) {
    const states = await this.states();
    const stateCodes = [...new Set(offices.map((o) => o.stateCode).filter(Boolean))];
    const districts = [...new Set(offices.map((o) => o.district).filter(Boolean))].sort();
    // One PIN in two states would be a data error; in that case offer no state
    // at all rather than pick one.
    const stateCode = stateCodes.length === 1 ? stateCodes[0] : null;
    const stateRow = stateCode ? states.find((s) => s.code === stateCode) : null;
    return {
      status: 'FOUND',
      pincode,
      source,
      state: stateRow ? { code: stateRow.code, name: stateRow.name } : null,
      // A PIN on a district border lists several. Only a single district is a
      // reliable suggestion; several are offered, never chosen for the customer.
      district: districts.length === 1 ? districts[0] : null,
      districts,
      localities: [...new Set(offices.map((o) => o.officeName))],
      postOffices: offices.map((o) => ({ name: o.officeName, type: o.officeType, delivery: o.delivery })),
      complete: Boolean(stateRow) && districts.length === 1,
    };
  }

  async districtsForState(stateCode) {
    const states = await this.states();
    if (!states.some((s) => s.code === stateCode)) return { status: 'UNKNOWN_STATE', stateCode, districts: [] };
    const rows = await this.query(
      `SELECT DISTINCT district FROM postal_offices
        WHERE state_code = ? AND district IS NOT NULL ORDER BY district`,
      [stateCode]);
    return { status: rows.length ? 'AVAILABLE' : 'UNAVAILABLE', stateCode, districts: rows.map((r) => r.district) };
  }

  async upsertOffices(offices, source) {
    const rows = offices.filter((o) => PIN_FORMAT.test(o.pincode) && o.officeName);
    if (!rows.length) return 0;
    const placeholders = rows.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(3))').join(', ');
    const values = rows.flatMap((o) => [
      o.pincode, cut(o.officeName, 160), cut(o.officeType, 16), cut(o.delivery, 24), cut(o.district, 120),
      cut(o.stateName, 120), o.stateCode ?? null, cut(o.division, 120), cut(o.region, 120), cut(o.circle, 120),
      o.latitude, o.longitude, source,
    ]);
    // A single lookup (LIVE) never downgrades a row a full sync delivered.
    await this.query(
      `INSERT INTO postal_offices
         (pincode, office_name, office_type, delivery, district, state_name, state_code,
          division_name, region_name, circle_name, latitude, longitude, source, synced_at)
       VALUES ${placeholders} AS incoming
       ON DUPLICATE KEY UPDATE
         office_type = incoming.office_type, delivery = incoming.delivery, district = incoming.district,
         state_name = incoming.state_name, state_code = incoming.state_code,
         division_name = incoming.division_name, region_name = incoming.region_name,
         circle_name = incoming.circle_name, latitude = incoming.latitude, longitude = incoming.longitude,
         source = IF(postal_offices.source = 'DIRECTORY', 'DIRECTORY', incoming.source),
         synced_at = incoming.synced_at`,
      values);
    return rows.length;
  }
}

function fromRow(row) {
  return {
    officeName: row.office_name,
    officeType: row.office_type,
    delivery: row.delivery,
    district: row.district,
    stateCode: row.state_code,
  };
}

export const postalService = new PostalService();
