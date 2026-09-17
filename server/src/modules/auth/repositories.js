// ADAPTED_SOURCE_TO_TARGET from
// corcotton-store/server/src/modules/otp/repository.js (Wave 5). Logic
// unchanged; adapted for target conventions: `query()` returns rows
// directly here (target's database/connection/pool.js) instead of
// `{ rows }` (source's db/pool.js), and `uuid` (npm package) replaced with
// Node's built-in `crypto.randomUUID()` (matches target's own
// modules/media/service.js convention — see docs/MIGRATION.md).
import { randomUUID } from 'node:crypto';
import { query } from '../../database/connection/pool.js';

export class OtpChallengeRepository {
  async create({
    id = randomUUID(),
    purpose,
    channel,
    destinationNormalized,
    otpHash,
    customerId = null,
    identityLinkRequestId = null,
    status = 'PENDING',
    attemptCount = 0,
    maxAttempts,
    expiresAt,
    requestedIp,
    userAgent,
  }) {
    await query(
      `INSERT INTO otp_challenges (
        id, purpose, channel, destination_normalized, otp_hash, customer_id,
        identity_link_request_id, status, attempt_count, max_attempts,
        expires_at, requested_ip, user_agent, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [id, purpose, channel, destinationNormalized, otpHash, customerId, identityLinkRequestId, status, attemptCount, maxAttempts, expiresAt, requestedIp, userAgent]
    );
    return this.findById(id);
  }

  async findById(id) {
    const rows = await query('SELECT * FROM otp_challenges WHERE id = ? LIMIT 1', [id]);
    return rows[0] || null;
  }

  async findLatestPendingByDestination(destinationNormalized, channel) {
    const rows = await query(
      `SELECT * FROM otp_challenges
       WHERE destination_normalized = ? AND channel = ? AND status = 'PENDING'
       ORDER BY created_at DESC LIMIT 1`,
      [destinationNormalized, channel]
    );
    return rows[0] || null;
  }

  async findLatestPendingContactChallenge(destinationNormalized, channel, customerId) {
    const rows = await query(
      `SELECT * FROM otp_challenges
       WHERE destination_normalized = ? AND channel = ? AND purpose = 'VERIFY_CONTACT'
         AND customer_id = ? AND status = 'PENDING'
       ORDER BY created_at DESC LIMIT 1`,
      [destinationNormalized, channel, customerId]
    );
    return rows[0] || null;
  }

  async cancelPendingByDestination(destinationNormalized, channel) {
    await query(
      `UPDATE otp_challenges
       SET status = 'CANCELLED'
       WHERE destination_normalized = ? AND channel = ? AND status = 'PENDING'`,
      [destinationNormalized, channel]
    );
  }

  async updateHash(id, otpHash) {
    await query('UPDATE otp_challenges SET otp_hash = ? WHERE id = ?', [otpHash, id]);
    return this.findById(id);
  }

  async incrementAttempts(id, attemptCount) {
    await query('UPDATE otp_challenges SET attempt_count = ? WHERE id = ?', [attemptCount, id]);
    return this.findById(id);
  }

  async lock(id) {
    await query("UPDATE otp_challenges SET status = 'LOCKED' WHERE id = ?", [id]);
    return this.findById(id);
  }

  async consume(id) {
    await query("UPDATE otp_challenges SET status = 'CONSUMED', consumed_at = NOW() WHERE id = ?", [id]);
    return this.findById(id);
  }

  async markExpired(id) {
    await query("UPDATE otp_challenges SET status = 'EXPIRED' WHERE id = ?", [id]);
    return this.findById(id);
  }
}
