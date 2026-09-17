import { withTransaction } from '../../database/connection/transaction.js';
import { AppError } from '../../utils/errors.js';
import { segmentRepository } from './repository.js';
import { compile, validateDefinition, attributeRegistry } from './ruleCompiler.js';

const SLUG = /^[a-z0-9](?:[a-z0-9-]{1,78}[a-z0-9])?$/;
const parseDef = (v) => (typeof v === 'string' ? JSON.parse(v) : v);

const maskName = (first, last) => {
  const n = [first, last].filter(Boolean).join(' ');
  if (!n) return null;
  return n.length <= 2 ? `${n[0]}***` : `${n.slice(0, 2)}***`;
};

/**
 * Customer Segments (Wave 8G-5). Definitions are dynamic (evaluated on demand
 * from the current revision); editing a rule mints a NEW immutable revision so
 * downstream references stay stable (§88/§92). Marketing audience resolution
 * always intersects membership with live consent + suppression (§91).
 */
export class SegmentService {
  constructor({ repository = segmentRepository, transaction = withTransaction } = {}) {
    this.repository = repository;
    this.transaction = transaction;
  }

  attributes() {
    return { attributes: attributeRegistry(), matchModes: ['ALL', 'ANY'] };
  }

  async list(filters) {
    const rows = await this.repository.list(filters);
    return rows.map((s) => this.#summary(s));
  }

  async detail(id) {
    const seg = await this.repository.byId(null, id);
    if (!seg) throw new AppError('SEGMENT_NOT_FOUND', 'Segment not found.', 404);
    const [revisions, snapshots] = await Promise.all([
      this.repository.revisionsForSegment(id),
      this.repository.snapshotsForSegment(id),
    ]);
    return {
      ...this.#summary(seg),
      revisions: revisions.map((r) => ({
        id: r.id, revision: Number(r.revision), matchMode: r.match_mode,
        definition: parseDef(r.definition_json), createdBy: r.created_by_email ?? null, at: r.created_at,
      })),
      snapshots: snapshots.map((sn) => ({
        id: sn.id, revisionId: sn.revision_id, revision: Number(sn.revision), reason: sn.reason,
        memberCount: Number(sn.member_count), createdBy: sn.created_by_email ?? null, at: sn.created_at,
      })),
    };
  }

  async create({ segmentKey, name, description, definition, staffId }) {
    const key = String(segmentKey || '').trim().toLowerCase();
    if (!SLUG.test(key)) throw new AppError('VALIDATION_ERROR', 'segmentKey must be a slug (a-z, 0-9, hyphen).', 400);
    if (!name || String(name).trim().length < 2) throw new AppError('VALIDATION_ERROR', 'A segment name is required.', 400);
    const def = validateDefinition(definition); // throws SEGMENT_RULE_INVALID
    if (await this.repository.byKey(key)) throw new AppError('SEGMENT_KEY_TAKEN', `Segment "${key}" already exists.`, 409);

    const id = await this.transaction(async (tx) => {
      const segmentId = await this.repository.insertSegment(tx, { segmentKey: key, name: String(name).trim(), description, staffId });
      const revisionId = await this.repository.insertRevision(tx, {
        segmentId, revision: 1, matchMode: def.match, definition: def, staffId,
      });
      await this.repository.updateSegment(tx, segmentId, { current_revision_id: revisionId });
      return segmentId;
    });
    return this.detail(id);
  }

  async updateMeta({ id, name, description, status }) {
    const seg = await this.repository.byId(null, id);
    if (!seg) throw new AppError('SEGMENT_NOT_FOUND', 'Segment not found.', 404);
    const fields = {};
    if (name !== undefined) {
      if (String(name).trim().length < 2) throw new AppError('VALIDATION_ERROR', 'A segment name is required.', 400);
      fields.name = String(name).trim();
    }
    if (description !== undefined) fields.description = description ? String(description).trim().slice(0, 500) : null;
    if (status !== undefined) {
      if (!['ACTIVE', 'ARCHIVED'].includes(status)) throw new AppError('VALIDATION_ERROR', 'status must be ACTIVE or ARCHIVED.', 400);
      fields.status = status;
    }
    if (!Object.keys(fields).length) throw new AppError('VALIDATION_ERROR', 'Nothing to update.', 400);
    await this.repository.updateSegment(null, id, fields);
    return this.detail(id);
  }

  /**
   * Edit the rule => a NEW revision. The prior revision stays resolvable so a
   * broadcast/promotion that pinned it keeps evaluating the exact same rule
   * (§88/§92).
   */
  async addRevision({ id, definition, staffId }) {
    const seg = await this.repository.byId(null, id);
    if (!seg) throw new AppError('SEGMENT_NOT_FOUND', 'Segment not found.', 404);
    const def = validateDefinition(definition);
    return this.transaction(async (tx) => {
      const revision = await this.repository.nextRevisionNumber(tx, id);
      const revisionId = await this.repository.insertRevision(tx, {
        segmentId: id, revision, matchMode: def.match, definition: def, staffId,
      });
      await this.repository.updateSegment(tx, id, { current_revision_id: revisionId });
      return { revisionId, revision };
    }).then(() => this.detail(id));
  }

  /** Preview an ad-hoc or saved definition: total count + a bounded, masked sample (§89). */
  async preview({ id = null, definition = null, sampleSize = 10 }) {
    let def = definition;
    if (!def) {
      if (!id) throw new AppError('VALIDATION_ERROR', 'Provide a definition or a segment id.', 400);
      const seg = await this.repository.byId(null, id);
      if (!seg) throw new AppError('SEGMENT_NOT_FOUND', 'Segment not found.', 404);
      def = { match: seg.match_mode, conditions: parseDef(seg.definition_json).conditions };
    }
    const compiled = compile(def); // throws SEGMENT_RULE_INVALID
    const [count, sample] = await Promise.all([
      this.repository.countMatching(compiled),
      this.repository.sampleMatching(compiled, sampleSize),
    ]);
    return {
      count,
      // Bounded, de-identified — never a raw PII dump (§89).
      sample: sample.map((c) => ({ id: c.id, name: maskName(c.first_name, c.last_name), status: c.status, since: c.created_at })),
    };
  }

  /** Customer ids matching the segment's current revision. */
  async memberIds(id) {
    const seg = await this.repository.byId(null, id);
    if (!seg) throw new AppError('SEGMENT_NOT_FOUND', 'Segment not found.', 404);
    const rev = await this.repository.revisionById(null, seg.current_revision_id);
    const def = parseDef(rev.definition_json);
    return this.repository.idsMatching(compile({ match: rev.match_mode, conditions: def.conditions }));
  }

  /**
   * Marketing audience = segment ∩ effective (channel,purpose) consent ∩ not
   * suppressed (§91). Pin a `revisionId` to make this deterministic while the
   * rule may be concurrently edited (§92); otherwise the current revision is
   * used and reported back.
   */
  async resolveAudience({ id, revisionId = null, channel, purpose }) {
    if (!['EMAIL', 'WHATSAPP'].includes(channel) || !['MARKETING', 'NEWSLETTER'].includes(purpose)) {
      throw new AppError('VALIDATION_ERROR', 'channel (EMAIL|WHATSAPP) and purpose (MARKETING|NEWSLETTER) are required.', 400);
    }
    const seg = await this.repository.byId(null, id);
    if (!seg) throw new AppError('SEGMENT_NOT_FOUND', 'Segment not found.', 404);

    let rev;
    if (revisionId) {
      rev = await this.repository.revisionById(null, revisionId);
      if (!rev || rev.segment_id !== id) throw new AppError('SEGMENT_REVISION_NOT_FOUND', 'That segment revision was not found.', 404);
    } else {
      rev = await this.repository.revisionById(null, seg.current_revision_id);
    }
    const def = parseDef(rev.definition_json);
    const compiled = compile({ match: rev.match_mode, conditions: def.conditions });
    const memberIds = await this.repository.idsMatching(compiled);
    const endpoints = await this.repository.marketableEndpoints(memberIds, { channel, purpose });
    const byCustomer = new Map();
    for (const e of endpoints) if (!byCustomer.has(e.customer_id)) byCustomer.set(e.customer_id, e.contact_key);
    return {
      segmentId: id,
      revisionId: rev.id,
      revision: Number(rev.revision),
      channel,
      purpose,
      segmentCount: memberIds.length,
      marketableCount: byCustomer.size,
      suppressedOrUnconsented: memberIds.length - byCustomer.size,
      recipients: [...byCustomer.entries()].map(([customerId, contactKey]) => ({ customerId, contactKey })),
    };
  }

  /**
   * Freeze the current revision's membership. Used for historical proof and as
   * the deterministic reference a broadcast audience is built from (§90/§92).
   */
  async snapshot({ id, reason = 'MANUAL', staffId }) {
    if (!['MANUAL', 'BROADCAST_AUDIENCE', 'PROMOTION', 'HISTORICAL_PROOF'].includes(reason)) {
      throw new AppError('VALIDATION_ERROR', 'Invalid snapshot reason.', 400);
    }
    const seg = await this.repository.byId(null, id);
    if (!seg) throw new AppError('SEGMENT_NOT_FOUND', 'Segment not found.', 404);
    const rev = await this.repository.revisionById(null, seg.current_revision_id);
    const def = parseDef(rev.definition_json);
    const compiled = compile({ match: rev.match_mode, conditions: def.conditions });
    const memberIds = await this.repository.idsMatching(compiled);
    const snapshotId = await this.transaction((tx) => this.repository.insertSnapshot(tx, {
      segmentId: id, revisionId: rev.id, reason, customerIds: memberIds, staffId,
    }));
    return { snapshotId, revisionId: rev.id, revision: Number(rev.revision), memberCount: memberIds.length };
  }

  segmentsForCustomer(customerId) {
    return this.repository.segmentsForCustomer(customerId, compile);
  }

  /** Does a customer currently match one ACTIVE segment's current revision? (used by promotions §100/§117) */
  async isMember(segmentId, customerId) {
    const seg = await this.repository.byId(null, segmentId);
    if (!seg || seg.status !== 'ACTIVE' || !seg.current_revision_id) return false;
    const rev = await this.repository.revisionById(null, seg.current_revision_id);
    if (!rev) return false;
    const def = parseDef(rev.definition_json);
    try {
      return await this.repository.matchesCustomer(compile({ match: rev.match_mode, conditions: def.conditions }), customerId);
    } catch {
      return false;
    }
  }

  #summary(s) {
    const def = s.definition_json ? parseDef(s.definition_json) : null;
    return {
      id: s.id,
      key: s.segment_key,
      name: s.name,
      description: s.description ?? null,
      status: s.status,
      currentRevisionId: s.current_revision_id ?? null,
      revision: s.revision != null ? Number(s.revision) : null,
      matchMode: s.match_mode ?? null,
      definition: def ? { match: s.match_mode ?? def.match, conditions: def.conditions } : null,
      createdAt: s.created_at,
      updatedAt: s.updated_at,
    };
  }
}

export const segmentService = new SegmentService();
