// COD refund payout destinations.
//
// A COD order has no payment instrument to refund to. Rather than blocking the
// return (which left customers who had returned goods with no money), the
// customer names a destination — UPI or a bank account — and the refund is
// paid out there by operations.
//
// This module is the ONLY place that reads or writes those details. Two rules
// hold everywhere else:
//   * nothing here is returned to a customer-facing response beyond a masked
//     summary;
//   * the account number is never logged, never echoed, and only decrypted on
//     the operator payout path.
import { randomUUID } from 'node:crypto';
import { AppError } from '../../utils/errors.js';
import { encryptPayoutSecret, decryptPayoutSecret, last4, payoutEncryptionAvailable } from '../../utils/payoutCrypto.js';

/** Payment modes with no online instrument to refund to. */
export const COD_PAYMENT_MODES = Object.freeze(['FULL_COD', 'PARTIAL_COD']);

/**
 * The safe shape. Everything a customer or a CMS list needs to recognise the
 * destination, and nothing an attacker could reuse. Deliberately has no branch
 * that can emit `account_number_cipher`.
 */
export function maskPayout(row) {
  if (!row) return null;
  const base = {
    method: row.method,
    submittedAt: row.submitted_at ? new Date(row.submitted_at).toISOString() : null,
  };
  if (row.method === 'UPI') {
    // name@bank -> na**@bank. The PSP stays visible because it tells the
    // customer which app the money is going to.
    const [handle = '', psp = ''] = String(row.upi_id || '').split('@');
    const shownHandle = handle.length <= 2 ? handle : `${handle.slice(0, 2)}${'*'.repeat(Math.min(handle.length - 2, 6))}`;
    return { ...base, upiIdMasked: psp ? `${shownHandle}@${psp}` : shownHandle };
  }
  return {
    ...base,
    accountHolderName: row.account_holder_name,
    accountNumberMasked: row.account_number_last4 ? `••••${row.account_number_last4}` : null,
    ifscCode: row.ifsc_code,
    bankName: row.bank_name,
  };
}

export class RefundPayoutService {
  /**
   * Store (or correct) the payout instruction for a return request. Idempotent
   * on return_request_id — a resubmission replaces the previous destination
   * rather than creating a competing one.
   *
   * @param {object} conn open transaction; the instruction and the return
   *   request must be committed together, so this never opens its own.
   */
  async submit(conn, { returnRequestId, customerId, brandId, payout }) {
    if (!payout) throw new AppError('REFUND_PAYOUT_REQUIRED', 'Choose how you would like the refund paid.', 400);

    let fields;
    if (payout.method === 'UPI') {
      fields = {
        upi_id: payout.upiId,
        account_holder_name: payout.accountHolderName ?? null,
        account_number_cipher: null, account_number_last4: null, ifsc_code: null, bank_name: null,
      };
    } else {
      // Refuse rather than store a bank account number in the clear.
      if (!payoutEncryptionAvailable()) {
        throw new AppError(
          'PAYOUT_ENCRYPTION_UNAVAILABLE',
          'Bank refunds are temporarily unavailable. Please choose UPI, or contact support.',
          503,
        );
      }
      fields = {
        upi_id: null,
        account_holder_name: payout.accountHolderName,
        account_number_cipher: encryptPayoutSecret(payout.accountNumber),
        account_number_last4: last4(payout.accountNumber),
        ifsc_code: payout.ifscCode,
        bank_name: payout.bankName ?? null,
      };
    }

    await conn.execute(
      `INSERT INTO refund_payout_details
         (id, brand_id, return_request_id, customer_id, method,
          upi_id, account_holder_name, account_number_cipher, account_number_last4, ifsc_code, bank_name)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         method = VALUES(method), upi_id = VALUES(upi_id),
         account_holder_name = VALUES(account_holder_name),
         account_number_cipher = VALUES(account_number_cipher),
         account_number_last4 = VALUES(account_number_last4),
         ifsc_code = VALUES(ifsc_code), bank_name = VALUES(bank_name),
         submitted_at = CURRENT_TIMESTAMP(3)`,
      [
        randomUUID(), brandId, returnRequestId, customerId, payout.method,
        fields.upi_id, fields.account_holder_name, fields.account_number_cipher,
        fields.account_number_last4, fields.ifsc_code, fields.bank_name,
      ],
    );

    return this.findMasked(returnRequestId, conn);
  }

  async find(returnRequestId, conn = null) {
    const exec = conn ? (sql, p) => conn.execute(sql, p).then((r) => r[0]) : null;
    const runner = exec || (await import('../../database/connection/pool.js')).query;
    const rows = await runner('SELECT * FROM refund_payout_details WHERE return_request_id = ?', [returnRequestId]);
    return rows[0] || null;
  }

  /** Safe for any response. */
  async findMasked(returnRequestId, conn = null) {
    return maskPayout(await this.find(returnRequestId, conn));
  }

  /**
   * The full destination, for the operator actually moving the money. Callers
   * must be behind the returns.refund permission, must not log the result, and
   * must not put it in an API response body.
   */
  async revealForPayout(returnRequestId) {
    const row = await this.find(returnRequestId);
    if (!row) return null;
    if (row.method === 'UPI') return { method: 'UPI', upiId: row.upi_id, accountHolderName: row.account_holder_name };
    return {
      method: 'BANK_ACCOUNT',
      accountHolderName: row.account_holder_name,
      accountNumber: decryptPayoutSecret(row.account_number_cipher),
      ifscCode: row.ifsc_code,
      bankName: row.bank_name,
    };
  }
}

export const refundPayoutService = new RefundPayoutService();
