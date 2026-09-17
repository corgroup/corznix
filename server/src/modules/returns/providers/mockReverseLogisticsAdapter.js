import { createHmac } from 'node:crypto';
import { env, isProduction } from '../../../config/index.js';

// Provider-neutral REVERSE logistics contract (§71): capability-specific
// methods, never a generic universal adapter. The MOCK implementation never
// touches the network — REAL_REVERSE_PROVIDER_CALLS stays 0.
//
// Simulation hooks (driven by the normalised request, like the forward mock):
//   pickup PIN 000000 / 999999  -> not serviceable
//   pickup PIN 888888           -> provider booking failure
//   request.simulate 'AMBIGUOUS' -> provider created the pickup but the
//                                   response was lost (UNKNOWN outcome)
const UNSERVICEABLE_PINS = new Set(['000000', '999999']);
const FAILURE_PIN = '888888';

// Raw carrier scan vocabulary -> normalised platform status (§78). Customers
// and CMS never see the left-hand side.
const SCAN_MAP = Object.freeze({
  'RT-PICKUP-REQUESTED': 'PENDING',
  'RT-PICKUP-ASSIGNED': 'PICKUP_SCHEDULED',
  'RT-OUT-FOR-PICKUP': 'PICKUP_SCHEDULED',
  'RT-PICKUP-DONE': 'PICKED_UP',
  'RT-IN-TRANSIT': 'IN_TRANSIT',
  'RT-BAGGED': 'IN_TRANSIT',
  'RT-RECEIVED-AT-FC': 'RECEIVED',
  'RT-DELIVERED-TO-WH': 'RECEIVED',
  'RT-CANCELLED': 'CANCELLED',
});

export class MockReverseLogisticsAdapter {
  constructor({ runtimeEnv = env, production = isProduction() } = {}) {
    this.providerCode = 'MOCK';
    this.configured = runtimeEnv.SHIPPING_PROVIDER_MODE === 'MOCK' && !production;
    this.webhookSecret = runtimeEnv.REVERSE_LOGISTICS_WEBHOOK_SECRET || 'mock-reverse-secret';
  }

  #assert() { if (!this.configured) throw new Error('MOCK_REVERSE_LOGISTICS_DISABLED'); }

  async checkReverseServiceability({ pickupPostalCode }) {
    this.#assert();
    const pin = String(pickupPostalCode || '');
    return {
      providerCode: this.providerCode,
      serviceable: /^\d{6}$/.test(pin) && !UNSERVICEABLE_PINS.has(pin),
      reason: UNSERVICEABLE_PINS.has(pin) ? 'PIN_NOT_SERVICEABLE' : null,
    };
  }

  async bookReturn(request) {
    this.#assert();
    const ref = String(request?.clientReference || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase() || 'UNKNOWN';
    const providerShipmentId = `mock-rev-${ref.toLowerCase()}`;
    const reverseAwb = `MOCKAWB${ref}`;
    if (request?.pickup?.postalCode === FAILURE_PIN) {
      throw Object.assign(new Error('MOCK_REVERSE_PROVIDER_FAILURE'), { retryable: true });
    }
    if (request?.simulate === 'AMBIGUOUS') {
      throw Object.assign(new Error('MOCK_REVERSE_PROVIDER_TIMEOUT'), { ambiguous: true, providerShipmentId, reverseAwb });
    }
    return {
      providerCode: this.providerCode,
      providerShipmentId,
      reverseAwb,
      trackingUrl: null,
      status: 'BOOKED',
      bookedAt: new Date().toISOString(),
      // Slice 19 — simulate the Delhivery FE running RVP QC at the door. The
      // agent answers each question's `correct_value` (QC PASS); `simulate
      // 'QC_FAIL'` flips the first REQUIRED question to a wrong answer.
      ...(Array.isArray(request?.customQc) && request.customQc.length
        ? { qcResult: mockQcAnswers(request.customQc, request.simulate === 'QC_FAIL') }
        : {}),
    };
  }

  async cancelReturn({ providerShipmentId, currentStatus }) {
    this.#assert();
    // The provider cannot un-pick-up a parcel (§77).
    if (['PICKED_UP', 'IN_TRANSIT', 'RECEIVED'].includes(currentStatus)) {
      return { cancelled: false, reason: 'ALREADY_IN_MOTION' };
    }
    return { cancelled: true, providerShipmentId, reason: null };
  }

  /** Poll simulation — returns raw provider scans, never normalised (§78). */
  async trackReturn({ providerShipmentId, since = null }) {
    this.#assert();
    void since;
    return { providerShipmentId, scans: [] };
  }

  /** §78 normaliser: raw carrier payload -> a normalised reverse event. */
  parseEvent(rawPayload) {
    const scanCode = rawPayload?.scan_code || rawPayload?.status || '';
    return {
      providerEventId: rawPayload?.event_id || rawPayload?.id || null,
      providerShipmentId: rawPayload?.awb || rawPayload?.shipment_id || null,
      providerStatus: scanCode || null,
      normalizedStatus: SCAN_MAP[scanCode] || null,
      occurredAt: rawPayload?.scan_time || rawPayload?.timestamp || null,
      locationText: rawPayload?.location || null,
      remarks: rawPayload?.remark || null,
    };
  }

  /** Authenticity seam (§79) — HMAC over the raw body. */
  verifyWebhookSignature(rawBody, signature) {
    if (!signature) return false;
    const expected = createHmac('sha256', this.webhookSecret)
      .update(typeof rawBody === 'string' ? rawBody : JSON.stringify(rawBody))
      .digest('hex');
    return signature === expected;
  }
}

// Deterministic FE-QC answer set for the mock. Answers use the CORCOTTON
// client_question_id (returnQcService.recordResult matches on it).
function mockQcAnswers(customQc, failFirstRequired) {
  const answers = [];
  let flipped = false;
  for (const item of customQc) {
    for (const q of item.questions || []) {
      const correct = Array.isArray(q.correct_value) ? q.correct_value : [];
      const qid = q.client_question_id || q.questions_id;
      if (q.type === 'text' || !correct.length) { answers.push({ questionId: qid, value: [] }); continue; }
      if (failFirstRequired && q.required && !flipped) {
        flipped = true;
        const wrong = (q.options || []).find((o) => !correct.includes(o)) || 'No';
        answers.push({ questionId: qid, value: [wrong] });
      } else {
        answers.push({ questionId: qid, value: [...correct] });
      }
    }
  }
  return { status: failFirstRequired ? 'FAIL' : 'PASS', answers, source: 'MOCK' };
}

export const mockReverseLogisticsAdapter = new MockReverseLogisticsAdapter();
