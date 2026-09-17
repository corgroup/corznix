import { env, isProduction } from '../../../config/index.js';
import { PROVIDER_CODES, ShippingProviderAdapter, SHIPPING_OPERATIONS } from '../providerContract.js';

export class MockShippingAdapter extends ShippingProviderAdapter {
  constructor({ runtimeEnv = env, production = isProduction() } = {}) {
    super({
      providerCode: PROVIDER_CODES.MOCK,
      configured: runtimeEnv.SHIPPING_PROVIDER_MODE === 'MOCK' && !production,
      // The dev/test provider stands in for the full operation surface so
      // integration tests can exercise every slice without a real carrier.
      capabilities: SHIPPING_OPERATIONS,
    });
    this.runtimeEnv = runtimeEnv;
  }

  async checkServiceability(request, options = {}) { return this.quote(request, options); }

  // Slice 4 — deterministic TAT for the PDP "check delivery" widget. MOCK only.
  async getTat(request) {
    if (!this.configured) throw new Error('MOCK_SHIPPING_DISABLED');
    const dest = String(request.destinationPostalCode || '');
    if (!/^\d{6}$/.test(dest)) throw new Error('MOCK_PROVIDER_REQUEST_INVALID');
    return {
      providerCode: this.providerCode,
      mode: request.mode || 'STANDARD',
      transitDays: request.mode === 'EXPRESS' ? 2 : 4,
      estimatedDeliveryDate: null,
    };
  }

  // Phase 2 §31 — provider-neutral name for booking. Delegates to the existing
  // 3-phase mock `book()` so its simulations (999999 fail, AMBIGUOUS) still work.
  async createShipment(request, options = {}) { return this.book(request, options); }

  // Mock label: no provider-hosted URL — signal the label service to use the
  // locally-rendered PDF (documentService.ensureShippingLabel). Not a "fake
  // label in real mode": this only runs while SHIPPING_PROVIDER_MODE=MOCK.
  async getLabel(request) {
    if (!this.configured) throw new Error('MOCK_SHIPPING_DISABLED');
    return {
      providerCode: this.providerCode,
      awb: String(request.awb || request.awbNumber || ''),
      format: 'RENDERED',
      size: request.size === 'A4' ? 'A4' : '4R',
      url: null,
      source: 'CORCOTTON_RENDERED',
      expiresAt: null,
    };
  }

  async requestPickup(request) {
    if (!this.configured) throw new Error('MOCK_SHIPPING_DISABLED');
    return {
      providerCode: this.providerCode,
      accepted: true,
      pickupId: `MOCKPUR-${String(request.pickupLocationName || 'WH').replace(/[^A-Za-z0-9]/g, '').toUpperCase()}-${request.pickupDate}`,
      scheduledFor: `${request.pickupDate}T${request.pickupTime || '11:00:00'}`,
    };
  }

  async editShipment(request) {
    if (!this.configured) throw new Error('MOCK_SHIPPING_DISABLED');
    return { providerCode: this.providerCode, awb: String(request.awb || request.awbNumber || ''), accepted: true, providerRemark: 'MOCK edit accepted' };
  }

  // Slice 18 — NDR action. Deterministic; AWB ending 999 models a carrier
  // rejection, `simulate:'AMBIGUOUS'` a lost response. MOCK only.
  async submitNdrAction(request) {
    if (!this.configured) throw new Error('MOCK_SHIPPING_DISABLED');
    const awb = String(request.awb || request.awbNumber || '');
    if (!awb || !['RE_ATTEMPT', 'RESCHEDULE'].includes(request.action)) throw new Error('MOCK_PROVIDER_REQUEST_INVALID');
    if (awb.endsWith('999')) {
      throw Object.assign(new Error('SHIPPING_PROVIDER_REJECTED'), { providerReason: 'MOCK: NDR not permitted for this shipment' });
    }
    if (request.simulate === 'AMBIGUOUS') {
      throw Object.assign(new Error('SHIPPING_PROVIDER_TIMEOUT'), { ambiguous: true });
    }
    return {
      providerCode: this.providerCode, awb, action: request.action,
      uplId: `MOCK-UPL-${awb}-${request.action}`, status: 'SUBMITTED', submittedAt: new Date().toISOString(),
    };
  }

  async getNdrStatus(request) {
    if (!this.configured) throw new Error('MOCK_SHIPPING_DISABLED');
    const uplId = String(request.uplId || '');
    if (!uplId) throw new Error('MOCK_PROVIDER_REQUEST_INVALID');
    // UPL id carrying REJECT -> REJECTED, else ACCEPTED (deterministic for tests).
    const state = /REJECT/i.test(uplId) ? 'REJECTED' : (/PENDING/i.test(uplId) ? 'PENDING' : 'ACCEPTED');
    return { providerCode: this.providerCode, uplId, state, providerRemark: `MOCK ${state}` };
  }

  // Slice 17 — download document. Deterministic; `request.simulateUnavailable`
  // models the carrier having no such document. MOCK only.
  async getDocuments(request) {
    if (!this.configured) throw new Error('MOCK_SHIPPING_DISABLED');
    const awb = String(request.awb || request.awbNumber || '');
    if (!awb || !['EPOD', 'QC_IMAGE', 'SIGNATURE'].includes(request.docType)) throw new Error('MOCK_PROVIDER_REQUEST_INVALID');
    if (request.simulateUnavailable) {
      return { providerCode: this.providerCode, awb, docType: request.docType, available: false, url: null };
    }
    return {
      providerCode: this.providerCode,
      awb,
      docType: request.docType,
      available: true,
      url: `https://mock.delhivery.local/pkg/document/${encodeURIComponent(awb)}/${request.docType}.png`,
      source: 'PROVIDER',
      expiresAt: null,
    };
  }

  // Slice 13 — track pull. Deterministic; `request.simulate` steers the returned
  // status ({statusText,statusType}) and `request.simulateEmpty` models "the
  // carrier has no shipment for this identifier" (what UNKNOWN-booking reconcile
  // needs to see). An orderReference query with no known AWB echoes a synthetic
  // one unless simulateEmpty is set.
  async trackShipment(request) {
    if (!this.configured) throw new Error('MOCK_SHIPPING_DISABLED');
    if (request.simulateEmpty) return { providerCode: this.providerCode, shipments: [] };
    const awbs = Array.isArray(request.awbNumbers) && request.awbNumbers.length
      ? request.awbNumbers.map((a) => String(a))
      : (request.awb || request.awbNumber ? [String(request.awb || request.awbNumber)] : []);
    const sim = request.simulate || {};
    const at = (sim.statusDateTime && new Date(sim.statusDateTime).toISOString())
      || new Date().toISOString();
    const one = (awb) => ({
      awb: awb || `MOCKAWB${String(request.orderReference || 'REF').replace(/[^A-Za-z0-9]/g, '').toUpperCase()}`,
      orderReference: request.orderReference || null,
      currentStatus: {
        statusText: sim.statusText || 'In Transit',
        statusType: sim.statusType || 'UD',
        statusDateTime: at,
        locationText: sim.locationText || 'MOCK_HUB',
        instructions: sim.instructions || null,
        nslCode: sim.nslCode || null,
      },
      history: Array.isArray(sim.history) ? sim.history : [],
    });
    const shipments = awbs.length ? awbs.map(one) : [one(null)];
    return { providerCode: this.providerCode, shipments };
  }

  async cancelShipment(request) {
    if (!this.configured) throw new Error('MOCK_SHIPPING_DISABLED');
    const awb = String(request.awb || request.awbNumber || '');
    // Simulation: AWB ending 999 models a shipment the carrier won't cancel.
    if (awb.endsWith('999')) {
      throw Object.assign(new Error('SHIPPING_PROVIDER_REJECTED'), { notAllowed: true, providerReason: 'MOCK: already dispatched' });
    }
    if (request.simulate === 'AMBIGUOUS') {
      throw Object.assign(new Error('SHIPPING_PROVIDER_TIMEOUT'), { ambiguous: true });
    }
    return { providerCode: this.providerCode, awb, cancelled: true, providerRemark: 'MOCK cancel accepted' };
  }

  /**
   * Provider-neutral shipment booking — MOCK only. Deterministic AWB derived
   * from the internal client reference. Never touches the network.
   * Simulations (driven by the normalised request): destination PIN `999999`
   * fails outright; `request.simulate === 'AMBIGUOUS'` models a provider that
   * created the shipment but whose response was lost.
   */
  async book(request) {
    if (!this.configured) throw new Error('MOCK_SHIPPING_DISABLED');
    const ref = String(request?.clientReference || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase() || 'UNKNOWN';
    const providerShipmentId = `mock-shp-${ref.toLowerCase()}`;
    const awbNumber = `MOCKAWB${ref}`;
    if (request?.destination?.postalCode === '999999') {
      throw Object.assign(new Error('MOCK_PROVIDER_FAILURE'), { retryable: true });
    }
    if (request?.simulate === 'AMBIGUOUS') {
      throw Object.assign(new Error('MOCK_PROVIDER_TIMEOUT'), { ambiguous: true, providerShipmentId, awbNumber });
    }
    return {
      providerCode: this.providerCode,
      providerShipmentId,
      awbNumber,
      trackingUrl: null,
      status: 'BOOKED',
      bookedAt: new Date().toISOString(),
    };
  }

  async quote(request) {
    if (!this.configured) throw new Error('MOCK_SHIPPING_DISABLED');
    if (request.destinationPostalCode === '999999') throw new Error('MOCK_PROVIDER_FAILURE');
    if (request.destinationPostalCode === '000000') return { providerCode: this.providerCode, serviceable: false, services: [] };
    return {
      providerCode: this.providerCode,
      serviceable: true,
      services: [{
        providerServiceCode: 'MOCK_STANDARD',
        rateMinor: Number(this.runtimeEnv.SHIPPING_STANDARD_CHARGE_MINOR),
        estimatedDeliveryAt: null,
        estimatedDays: 3,
        codSupported: true,
        metadata: { mock: true, rateSource: 'MOCK_CONFIGURATION' },
      }],
    };
  }
}
