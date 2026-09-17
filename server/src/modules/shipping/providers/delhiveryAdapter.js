import { env } from '../../../config/index.js';
import { PROVIDER_CODES, ShippingProviderAdapter } from '../providerContract.js';
import { buildManifestPayload, encodeManifestBody, parseManifestResponse } from './delhiveryManifest.js';
import { parseTrackResponse } from './delhiveryTrack.js';
import { DELHIVERY_DOC_TYPE, parseDocumentResponse } from './delhiveryDocuments.js';
import { buildNdrUpdateBody, parseNdrUpdateResponse, parseNdrStatusResponse } from './delhiveryNdr.js';
import { buildWarehouseCreatePayload, buildWarehouseEditPayload, parseWarehouseResponse } from './delhiveryWarehouse.js';

// Real Delhivery adapter — READ operations only (Phase 2 slices 2 + 9):
//   * checkServiceability  GET /c/api/pin-codes/json/
//   * getTat               GET /api/dc/expected_tat
//   * getShippingQuote     GET /api/kinko/v1/invoice/charges/.json
//
// Write operations (createShipment / getLabel / requestPickup / editShipment /
// cancelShipment / trackShipment / getDocuments) are added in later slices and
// are NOT declared in `capabilities` until then — the ProviderResolver returns
// a 503 for anything not yet implemented, never a fallback.
//
// Provider-native JSON, field names, status strings and endpoints never leave
// this file. Every request field traces to Dev_API.docx
// (implementation/phase-02/01-provider-contract-evidence.md). Where the doc is
// silent on a RESPONSE shape, the parser looks across the plausible field names
// and FAILS LOUD if none match — it never fabricates a value.
export class DelhiveryShippingAdapter extends ShippingProviderAdapter {
  constructor({ runtimeEnv = env } = {}) {
    super({
      providerCode: PROVIDER_CODES.DELHIVERY,
      configured:
        runtimeEnv.SHIPPING_PROVIDER_MODE === 'REAL'
        && Boolean(runtimeEnv.DELHIVERY_API_BASE_URL && runtimeEnv.DELHIVERY_API_TOKEN),
      capabilities: [
        'checkServiceability', 'getTat', 'getShippingQuote', 'createShipment',
        'getLabel', 'requestPickup', 'editShipment', 'cancelShipment', 'trackShipment',
        'getDocuments', 'submitNdrAction', 'getNdrStatus',
        'createPickupLocation', 'updatePickupLocation',
      ],
    });
    this.env = runtimeEnv;
  }

  #baseUrl() {
    return String(this.env.DELHIVERY_API_BASE_URL).replace(/\/+$/, '');
  }

  // Deliberately fails CLOSED: a real Delhivery host counts as live unless its
  // name says otherwise. `DELHIVERY_ENVIRONMENT` is NOT consulted — an explicit
  // DELHIVERY_API_BASE_URL overrides it (see config/env.js), so the URL is the
  // only thing that says where a request actually lands.
  #isLiveCarrierHost() {
    let host;
    try {
      host = new URL(this.#baseUrl()).hostname.toLowerCase();
    } catch {
      return false; // not a URL at all — nothing can be booked against it
    }
    if (host !== 'delhivery.com' && !host.endsWith('.delhivery.com')) return false;
    return !/(^|[.-])(staging|uat|sandbox|test|demo)([.-]|$)/.test(host);
  }

  // Refuses an operation that has a real-world consequence — a parcel booked,
  // a van dispatched, a pickup location created — when a NON-PRODUCTION
  // process is pointed at Delhivery's LIVE host.
  //
  // This is not hypothetical. A developer machine with
  // DELHIVERY_API_BASE_URL=https://track.delhivery.com booked AWB
  // 54729910000151 against the live account during a QA run and would have
  // scheduled a real pickup from the Parsupur warehouse; it was only caught
  // because someone was watching. Reads stay open — serviceability, TAT,
  // rate quotes and tracking cost nothing and local work needs them.
  //
  // Deployed stacks run NODE_ENV=production, so neither staging nor production
  // is affected; this only ever bites a developer machine or CI. The escape
  // hatch is explicit: DELHIVERY_ALLOW_LIVE_WRITES=true, which nobody sets by
  // accident.
  #assertWritesAllowed(operation) {
    if (!this.#isLiveCarrierHost()) return;
    if (this.env.NODE_ENV === 'production') return;
    if (String(this.env.DELHIVERY_ALLOW_LIVE_WRITES) === 'true') return;
    const err = new Error('SHIPPING_PROVIDER_LIVE_WRITE_BLOCKED');
    err.detail = `Refused ${operation}: NODE_ENV=${this.env.NODE_ENV || 'unset'} is pointed at `
      + `Delhivery's live host (${this.#baseUrl()}). This would create a real shipment. `
      + 'Use the UAT base URL, or set DELHIVERY_ALLOW_LIVE_WRITES=true if you truly mean it.';
    throw err;
  }

  // Shared POST. A create request that was SENT but whose response is lost is
  // AMBIGUOUS — the shipment may exist at Delhivery (brief §13/§41). Such an
  // error carries `.ambiguous = true` so the booking service records
  // BOOKING_UNKNOWN and reconciles instead of blindly re-creating.
  async #post(path, bodyString, { timeoutMs = Number(this.env.SHIPPING_PROVIDER_TIMEOUT_MS) || 5000, signal = null, ambiguousOnFailure = false } = {}) {
    if (!this.configured) throw new Error('SHIPPING_PROVIDER_NOT_CONFIGURED');
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetch(`${this.#baseUrl()}${path}`, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json', // documented form, even though body is form-encoded
          Authorization: `Token ${this.env.DELHIVERY_API_TOKEN}`,
        },
        body: bodyString,
        signal: controller.signal,
      });
    } catch (error) {
      const aborted = controller.signal.aborted;
      const e = new Error(aborted ? 'SHIPPING_PROVIDER_TIMEOUT' : 'SHIPPING_PROVIDER_UNREACHABLE');
      if (ambiguousOnFailure) e.ambiguous = true; // request left our process — outcome unknown
      throw e;
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }

    if (!response.ok) {
      // A non-2xx from a create endpoint is a definite failure for 4xx, but a
      // 5xx / gateway error is ambiguous (the request reached the provider).
      if (response.status === 401 || response.status === 403) throw new Error('SHIPPING_PROVIDER_AUTH_FAILED');
      if (response.status === 429) throw new Error('SHIPPING_PROVIDER_RATE_LIMITED');
      if (response.status >= 500) {
        const e = new Error('SHIPPING_PROVIDER_UNAVAILABLE');
        if (ambiguousOnFailure) e.ambiguous = true;
        throw e;
      }
      throw new Error('SHIPPING_PROVIDER_REJECTED');
    }
    const data = await response.json().catch(() => null);
    if (data == null) throw new Error('SHIPPING_PROVIDER_RESPONSE_INVALID');
    return data;
  }

  // Shared GET. Own AbortController timeout; provider errors mapped to the
  // neutral vocabulary; body never surfaced.
  async #get(path, { query = {}, timeoutMs = Number(this.env.SHIPPING_PROVIDER_TIMEOUT_MS) || 5000, signal = null } = {}) {
    if (!this.configured) throw new Error('SHIPPING_PROVIDER_NOT_CONFIGURED');
    const url = new URL(`${this.#baseUrl()}${path}`);
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }

    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetch(url, {
        method: 'GET',
        headers: { Accept: 'application/json', Authorization: `Token ${this.env.DELHIVERY_API_TOKEN}` },
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) throw new Error('SHIPPING_PROVIDER_TIMEOUT');
      throw new Error('SHIPPING_PROVIDER_UNREACHABLE');
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) throw new Error('SHIPPING_PROVIDER_AUTH_FAILED');
      if (response.status === 429) throw new Error('SHIPPING_PROVIDER_RATE_LIMITED');
      throw new Error(response.status >= 500 ? 'SHIPPING_PROVIDER_UNAVAILABLE' : 'SHIPPING_PROVIDER_REJECTED');
    }
    const data = await response.json().catch(() => null);
    if (data == null) throw new Error('SHIPPING_PROVIDER_RESPONSE_INVALID');
    return data;
  }

  // ---- serviceability ------------------------------------------------

  async checkServiceability(request, options = {}) { return this.quote(request, options); }

  async quote(request, { signal } = {}) {
    const pin = String(request.destinationPostalCode || '');
    if (!/^\d{6}$/.test(pin)) throw new Error('SHIPPING_PROVIDER_RESPONSE_INVALID');

    const data = await this.#get('/c/api/pin-codes/json/', { query: { filter_codes: pin }, signal });
    const codes = normalizeDeliveryCodes(data);
    if (codes === null) throw new Error('SHIPPING_PROVIDER_RESPONSE_INVALID');

    const entry = codes
      .map((row) => row?.postal_code ?? row)
      .find((pc) => pc && String(pc.pin ?? '') === pin);
    if (!entry) return { providerCode: this.providerCode, serviceable: false, services: [] };

    const yes = (value) => String(value ?? '').trim().toUpperCase() === 'Y';
    const codSupported = yes(entry.cod);
    const prepaidSupported = yes(entry.pre_paid);
    // "Embargo" in `remark` = temporary NSZ (Dev_API.docx §B2C serviceability).
    const embargo = String(entry.remark ?? '').trim().toLowerCase() === 'embargo';
    if ((!codSupported && !prepaidSupported) || embargo) {
      return {
        providerCode: this.providerCode,
        serviceable: false,
        services: [],
        ...(embargo ? { temporary: true } : {}),
      };
    }

    const maxAmount = Number(entry.max_amount);
    const maxCodAmountMinor = Number.isFinite(maxAmount) && maxAmount > 0 ? Math.round(maxAmount * 100) : null;

    // The serviceability row already names the place the PIN belongs to, which
    // is what lets the storefront echo "Noida, Uttar Pradesh" back to a customer
    // instead of a bare six-digit number. Delhivery is not consistent about
    // which key carries it across accounts, so read across the plausible ones
    // and keep null when none is present — the caller renders nothing rather
    // than guessing a place name.
    const locality = {
      city: firstString(entry, ['city', 'district', 'inc_city', 'town']),
      state: firstString(entry, ['state', 'state_code', 'inc_state']),
    };

    // The PIN response says the pin is serviceable; it says nothing about
    // Surface vs Express, which is why this used to return exactly one service
    // and the storefront could only ever offer one method. The mode split is
    // real at booking time (`shipping_mode`), so it has to be answered here
    // too — and the only endpoint that answers it per PIN is the TAT one.
    const service = (providerServiceCode, extra = {}) => ({
      providerServiceCode,
      rateMinor: 0,
      estimatedDeliveryAt: null,
      estimatedDays: null,
      codSupported,
      prepaidSupported,
      maxCodAmountMinor,
      minCodAmountMinor: null,
      metadata: {
        rateUnavailable: true,
        rateSource: 'PROVIDER_SERVICEABILITY',
        pickupSupported: yes(entry.pickup),
        outOfDeliveryArea: yes(entry.is_oda),
        center: typeof entry.inc === 'string' ? entry.inc : null,
      },
      ...extra,
    });

    const services = [service('PIN_SERVICEABILITY')];

    // Only the quote path asks for the mode split — a bare serviceability check
    // (per-lane warehouse screening, for one) must stay a single cheap call.
    const origin = String(request.originPostalCode || '');
    if (request.quoteServiceLevels && /^\d{6}$/.test(origin)) {
      const budgetMs = Math.max(1000, Math.min(Number(this.env.SHIPPING_PROVIDER_TIMEOUT_MS) || 5000, 3000));
      const tatDays = async (mode) => {
        try {
          const tat = await this.getTat({ originPostalCode: origin, destinationPostalCode: pin, mode }, { signal, timeoutMs: budgetMs });
          return tat.transitDays ?? null;
        } catch { return null; } // an unanswered TAT must never fail the quote
      };
      // What the shipment weighs, from the resolved cart lines. Without it the
      // carrier cannot price anything, so the rate calls are simply skipped.
      const weightGrams = Array.isArray(request.items)
        ? request.items.reduce((sum, item) => {
          const grams = Number(item?.fulfillment?.weightGrams);
          const qty = Number(item?.quantity) || 0;
          return Number.isFinite(grams) && grams > 0 && qty > 0 ? sum + grams * qty : sum;
        }, 0)
        : 0;
      const everyLinePriceable = Array.isArray(request.items) && request.items.length > 0
        && request.items.every((item) => Number(item?.fulfillment?.weightGrams) > 0);

      const rateMinorFor = async (mode) => {
        if (!everyLinePriceable || weightGrams <= 0) return null;
        try {
          const quoted = await this.getShippingQuote({
            originPostalCode: origin, destinationPostalCode: pin, weightGrams, mode,
            paymentType: request.paymentType === 'COD' ? 'COD' : 'Pre-paid',
          }, { signal, timeoutMs: budgetMs });
          return Number.isFinite(quoted.rateMinor) && quoted.rateMinor >= 0 ? quoted.rateMinor : null;
        } catch { return null; } // never fail the quote over a rate lookup
      };

      const [surfaceDays, expressDays, surfaceRate, expressRate] = await Promise.all([
        tatDays('STANDARD'), tatDays('EXPRESS'), rateMinorFor('STANDARD'), rateMinorFor('EXPRESS'),
      ]);

      if (surfaceDays != null) services[0].estimatedDays = surfaceDays;
      // The Surface rate is the business's own cost, not the customer's price —
      // the pricing policy decides that, and its default absorbs it. Reporting
      // the real number is what makes `actualLogisticsCostMinor` true, and what
      // makes the CMS's "Provider rate" Surface mode work at all: with a
      // hardcoded 0 that setting silently charged nothing.
      if (surfaceRate != null) {
        services[0].rateMinor = surfaceRate;
        services[0].metadata = { ...services[0].metadata, rateUnavailable: false, rateSource: 'PROVIDER' };
      }

      // Express is offered only where Delhivery quotes BOTH a transit time and
      // a price for it. A missing TAT means we cannot prove the mode runs to
      // this PIN; a missing rate means we would have to charge the surcharge
      // alone and eat the carriage, which is not what the pricing policy says.
      // Either way the customer is not shown a mode we cannot stand behind.
      if (expressDays != null && expressRate != null) {
        services.push(service('EXPRESS', {
          estimatedDays: expressDays,
          rateMinor: expressRate,
          metadata: {
            rateUnavailable: false,
            rateSource: 'PROVIDER',
            pickupSupported: yes(entry.pickup),
            outOfDeliveryArea: yes(entry.is_oda),
            center: typeof entry.inc === 'string' ? entry.inc : null,
          },
        }));
      }
    }

    return {
      providerCode: this.providerCode,
      serviceable: true,
      locality: locality.city || locality.state ? locality : null,
      services,
    };
  }

  // ---- shipment creation (manifest) — POST /api/cmu/create.json ------
  // Provider-neutral in, provider-neutral out. Idempotency + BOOKING_UNKNOWN
  // handling live in ShipmentBookingService (the attempt ledger); this method
  // just performs the one call and normalises the result.
  async createShipment(request, { signal } = {}) {
    this.#assertWritesAllowed('createShipment');
    let dataObject;
    try {
      ({ dataObject } = buildManifestPayload(request));
    } catch (err) {
      // A payload we could not even assemble never reached the provider.
      const e = new Error(err.code === 'MANIFEST_PAYLOAD_INCOMPLETE' ? 'SHIPPING_PROVIDER_REQUEST_INVALID' : 'SHIPPING_PROVIDER_REQUEST_INVALID');
      e.detail = err.message;
      throw e;
    }
    const { body } = encodeManifestBody(dataObject);

    const data = await this.#post('/api/cmu/create.json', body, {
      timeoutMs: Math.max(Number(this.env.SHIPPING_PROVIDER_TIMEOUT_MS) || 5000, 15000), // P99 ~1.6s but be generous
      signal,
      ambiguousOnFailure: true,
    });

    const parsed = parseManifestResponse(data);
    if (!parsed.ok) {
      // Provider replied, definitively, without an AWB — a real rejection.
      const e = new Error(parsed.code === 'PROVIDER_REJECTED' ? 'SHIPPING_PROVIDER_REJECTED' : 'SHIPPING_PROVIDER_RESPONSE_INVALID');
      e.providerReason = parsed.remark || null; // safe operator-facing string, no raw JSON
      throw e;
    }

    return {
      providerCode: this.providerCode,
      providerShipmentId: parsed.providerShipmentId || parsed.awb,
      awbNumber: parsed.awb,
      trackingUrl: `https://www.delhivery.com/track/package/${encodeURIComponent(parsed.awb)}`,
      status: 'BOOKED',
      bookedAt: new Date().toISOString(),
      providerRemark: parsed.remark || null,
    };
  }

  // ---- shipment edit — POST /api/p/edit ---------------------------
  // Allowed only while Manifested / In Transit / Pending (Dev_API.docx).
  async editShipment(request, { signal } = {}) {
    this.#assertWritesAllowed('editShipment');
    const awb = String(request.awb || request.awbNumber || '');
    if (!awb) throw new Error('SHIPPING_PROVIDER_REQUEST_INVALID');
    const body = { waybill: awb };
    if (request.name) body.name = request.name;
    if (request.phone) body.phone = request.phone;
    if (request.address) body.add = request.address;
    if (request.productsDesc) body.products_desc = request.productsDesc;
    if (Number(request.weightGrams) > 0) body.gm = Math.round(Number(request.weightGrams));
    if (Number(request.lengthMm) > 0) body.shipment_length = Math.round(request.lengthMm / 10);
    if (Number(request.widthMm) > 0) body.shipment_width = Math.round(request.widthMm / 10);
    if (Number(request.heightMm) > 0) body.shipment_height = Math.round(request.heightMm / 10);
    if (request.paymentMode) {
      body.pt = request.paymentMode === 'COD' ? 'COD' : 'Pre-paid';
      if (request.paymentMode === 'COD' && Number(request.codAmountMinor) > 0) body.cod = Number(request.codAmountMinor) / 100;
    }
    if (Object.keys(body).length === 1) throw new Error('SHIPPING_PROVIDER_REQUEST_INVALID'); // nothing to edit

    const data = await this.#post('/api/p/edit', JSON.stringify(body), { signal });
    return { providerCode: this.providerCode, awb, accepted: parseEditOk(data), providerRemark: safeRemark(data) };
  }

  // ---- shipment cancellation — POST /api/p/edit {cancellation:'true'} ----
  // Manifested (pre-pickup) -> stays Manifested (UD): clean cancel.
  // In Transit / Pending    -> stays In Transit, type RT: becomes an RTO.
  // Not allowed on Dispatched / terminal.
  async cancelShipment(request, { signal } = {}) {
    this.#assertWritesAllowed('cancelShipment');
    const awb = String(request.awb || request.awbNumber || '');
    if (!awb) throw new Error('SHIPPING_PROVIDER_REQUEST_INVALID');

    const data = await this.#post('/api/p/edit', JSON.stringify({ waybill: awb, cancellation: 'true' }), {
      signal,
      ambiguousOnFailure: true, // a lost response after a cancel is genuinely unknown
    });

    if (!parseEditOk(data)) {
      const e = new Error('SHIPPING_PROVIDER_REJECTED');
      e.providerReason = safeRemark(data);
      e.notAllowed = /not allowed|cannot be cancel|already|terminal|dispatched|invalid/i.test(String(safeRemark(data) || ''));
      throw e;
    }
    return {
      providerCode: this.providerCode,
      awb,
      cancelled: true,
      providerRemark: safeRemark(data),
    };
  }

  // ---- pickup request — POST /fm/request/new/ ---------------------
  // Warehouse-level: one request covers every package ready at that location.
  async requestPickup(request, { signal } = {}) {
    this.#assertWritesAllowed('requestPickup');
    const name = String(request.pickupLocationName || '');
    if (!name) throw new Error('SHIPPING_PROVIDER_REQUEST_INVALID');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(request.pickupDate || ''))) throw new Error('SHIPPING_PROVIDER_REQUEST_INVALID');
    const count = Number(request.expectedPackageCount);
    if (!Number.isInteger(count) || count < 1) throw new Error('SHIPPING_PROVIDER_REQUEST_INVALID');
    const time = /^\d{2}:\d{2}:\d{2}$/.test(String(request.pickupTime || '')) ? request.pickupTime : '14:00:00';

    const data = await this.#post('/fm/request/new/', JSON.stringify({
      pickup_time: time,
      pickup_date: request.pickupDate,
      pickup_location: name,
      expected_package_count: count,
    }), { signal, ambiguousOnFailure: true });

    const node = firstRecord(data);
    const pickupId = firstString(node, ['pickup_id', 'prepaid', 'pr_id', 'id', 'incoming_center_id'])
      || firstString(data, ['pickup_id', 'id']);
    const rejected = data && (data.success === false || firstString(data, ['error']));
    if (rejected && !pickupId) {
      const e = new Error('SHIPPING_PROVIDER_REJECTED');
      e.providerReason = firstString(data, ['error', 'rmk', 'message']) || null;
      throw e;
    }

    return {
      providerCode: this.providerCode,
      accepted: true,
      pickupId: pickupId || null,
      scheduledFor: `${request.pickupDate}T${time}`,
    };
  }

  // ---- pickup-location registration — POST /api/backend/clientwarehouse/create/
  // Contract row 13. `name` becomes the `pickup_location` every later manifest
  // sends, so it is the join key between the two systems and is never
  // normalised here. A create whose response we cannot read as success throws:
  // the caller must not persist a mapping Delhivery has not confirmed.
  async createPickupLocation(warehouse, { signal } = {}) {
    this.#assertWritesAllowed('createPickupLocation');
    let payload;
    try {
      payload = buildWarehouseCreatePayload(warehouse);
    } catch (err) {
      const e = new Error('SHIPPING_PROVIDER_REQUEST_INVALID');
      e.detail = err.message;
      throw e;
    }
    // Ambiguous on transport failure: the warehouse may exist at Delhivery
    // even though we never saw the reply, and a blind retry would collide on
    // the unique name (there is no read endpoint to check first).
    const data = await this.#post('/api/backend/clientwarehouse/create/', JSON.stringify(payload), {
      signal, ambiguousOnFailure: true,
    });
    const parsed = parseWarehouseResponse(data);
    return {
      providerCode: this.providerCode,
      providerLocationName: parsed.providerLocationName || payload.name,
      registeredAt: parsed.registeredAt,
    };
  }

  // ---- pickup-location edit — POST /api/backend/clientwarehouse/edit/
  // Contract row 14. `name` identifies the warehouse and is IMMUTABLE at
  // Delhivery; only address / phone travel as changes.
  async updatePickupLocation(providerLocationName, patch, { signal } = {}) {
    this.#assertWritesAllowed('updatePickupLocation');
    let payload;
    try {
      payload = buildWarehouseEditPayload(providerLocationName, patch);
    } catch (err) {
      const e = new Error('SHIPPING_PROVIDER_REQUEST_INVALID');
      e.detail = err.message;
      throw e;
    }
    const data = await this.#post('/api/backend/clientwarehouse/edit/', JSON.stringify(payload), {
      signal, ambiguousOnFailure: true,
    });
    parseWarehouseResponse(data);
    return { providerCode: this.providerCode, providerLocationName, updatedAt: new Date() };
  }

  // ---- shipping label — GET /api/p/packing_slip ---------------------
  // pdf=true ⇒ Delhivery returns an S3 link to the label PDF (not customisable).
  // Provider-hosted; CORCOTTON persists the URL + status on the shipment.
  async getLabel(request, { signal } = {}) {
    const awb = String(request.awb || request.awbNumber || '');
    if (!awb) throw new Error('SHIPPING_PROVIDER_REQUEST_INVALID');
    const size = request.size === '4R' || request.size === 'A4' ? request.size : '4R';

    const data = await this.#get('/api/p/packing_slip', {
      // Delhivery documents this endpoint at 210ms average but 61.78s P99 —
      // the slowest 1% take a minute. A 20s cap (what this was) aborts those
      // as SHIPPING_PROVIDER_TIMEOUT even though the request would have
      // succeeded, and the shipment is left BOOKED with label FAILED for no
      // real reason. The floor now clears the documented P99.
      timeoutMs: Math.max(Number(this.env.SHIPPING_PROVIDER_TIMEOUT_MS) || 5000, 65000),
      query: { wbns: awb, pdf: 'true', pdf_size: size },
      signal,
    });

    const urlKeys = ['pdf_download_link', 'download_url', 'pdf', 'label_url', 's3_link', 'url', 'packing_slip'];
    const pkg = Array.isArray(data?.packages) && data.packages[0] && typeof data.packages[0] === 'object' ? data.packages[0] : null;
    const url = firstString(pkg, urlKeys)
      || firstString(firstRecord(data), urlKeys)
      || firstString(data, urlKeys);
    if (!url || !/^https?:\/\//i.test(url)) throw new Error('SHIPPING_PROVIDER_RESPONSE_INVALID');

    return {
      providerCode: this.providerCode,
      awb,
      format: 'PDF',
      size,
      url,
      source: 'PROVIDER',
      // Delhivery S3 links expire; the caller should copy the bytes into
      // CORCOTTON storage if long-term retention is required (§17).
      expiresAt: null,
    };
  }

  // ---- TAT / expected delivery -------------------------------------
  // GET /api/dc/expected_tat?origin_pin=&destination_pin=&mot=S|E|N&pdt=B2C
  //   mode: 'STANDARD' -> S (Surface), 'EXPRESS' -> E (Express), 'NDD' -> N
  async getTat(request, { signal, timeoutMs } = {}) {
    const origin = String(request.originPostalCode || '');
    const dest = String(request.destinationPostalCode || '');
    if (!/^\d{6}$/.test(origin) || !/^\d{6}$/.test(dest)) throw new Error('SHIPPING_PROVIDER_REQUEST_INVALID');
    const mot = MOT_FOR[request.mode] || 'S';

    const data = await this.#get('/api/dc/expected_tat', {
      ...(timeoutMs ? { timeoutMs } : {}),
      query: {
        origin_pin: origin,
        destination_pin: dest,
        mot,
        pdt: 'B2C',
        expected_pickup_date: request.expectedPickupDate || undefined,
      },
      signal,
    });

    const node = firstRecord(data);
    const days = firstNumber(node, ['tat', 'expected_tat', 'tat_days', 'edd_days', 'days', 'expected_tat_days']);
    const edd = firstString(node, ['expected_delivery_date', 'edd', 'expected_date', 'promised_delivery_date']);
    if (days == null && !edd) throw new Error('SHIPPING_PROVIDER_RESPONSE_INVALID');

    return {
      providerCode: this.providerCode,
      mode: request.mode || 'STANDARD',
      transitDays: days == null ? null : Math.max(0, Math.round(days)),
      estimatedDeliveryDate: normalizeDate(edd),
    };
  }

  // ---- shipping cost ---------------------------------------------------
  // GET /api/kinko/v1/invoice/charges/.json?md=E|S&cgm={grams}&o_pin=&d_pin=&ss=Delivered&pt=Pre-paid|COD&l=&b=&h=
  async getShippingQuote(request, { signal, timeoutMs } = {}) {
    const origin = String(request.originPostalCode || '');
    const dest = String(request.destinationPostalCode || '');
    if (!/^\d{6}$/.test(origin) || !/^\d{6}$/.test(dest)) throw new Error('SHIPPING_PROVIDER_REQUEST_INVALID');
    const grams = Number(request.weightGrams);
    if (!Number.isFinite(grams) || grams <= 0) throw new Error('SHIPPING_PROVIDER_REQUEST_INVALID');

    const md = request.mode === 'EXPRESS' ? 'E' : 'S';
    const pt = request.paymentType === 'COD' ? 'COD' : 'Pre-paid';

    const data = await this.#get('/api/kinko/v1/invoice/charges/.json', {
      // P99 is ~61s for this endpoint (Dev_API.docx) — give it more room when
      // nobody is waiting. A caller inside the checkout quote passes its own,
      // much tighter budget and treats a timeout as "no Express offered".
      timeoutMs: timeoutMs ?? Math.max(Number(this.env.SHIPPING_PROVIDER_TIMEOUT_MS) || 5000, 15000),
      query: {
        md,
        cgm: Math.round(grams),
        o_pin: origin,
        d_pin: dest,
        ss: 'Delivered',
        pt,
        // mm -> cm, adapter-only (brief §37).
        l: request.lengthMm ? Math.round(request.lengthMm / 10) : undefined,
        b: request.widthMm ? Math.round(request.widthMm / 10) : undefined,
        h: request.heightMm ? Math.round(request.heightMm / 10) : undefined,
        ipkg_type: request.packageType || undefined,
      },
      signal,
    });

    const node = firstRecord(data);
    const rupees = firstNumber(node, ['total_amount', 'total', 'gross_amount', 'charge_total', 'amount', 'final_amount']);
    if (rupees == null || rupees < 0) throw new Error('SHIPPING_PROVIDER_RESPONSE_INVALID');

    return {
      providerCode: this.providerCode,
      mode: request.mode === 'EXPRESS' ? 'EXPRESS' : 'STANDARD',
      rateMinor: Math.round(rupees * 100),
      currency: 'INR',
      chargeableWeightGrams: firstNumber(node, ['charged_weight', 'chargeable_weight', 'cgm']) ?? Math.round(grams),
      rateSource: 'PROVIDER',
    };
  }

  // ---- track / reconciliation — GET /api/v1/packages/json/ -----------
  // Slice 13: the PULL counterpart to the Scan Push webhook. `?waybill={csv}`
  // (≤ 50, comma-separated) OR `?ref_ids={orderRef}`. Returns provider-neutral
  // entries — the raw Delhivery shape is confined to delhiveryTrack.js, which
  // fails loud on an unreadable body and never fabricates a status.
  async trackShipment(request, { signal } = {}) {
    const awbs = Array.isArray(request.awbNumbers) && request.awbNumbers.length
      ? request.awbNumbers.map((a) => String(a).trim()).filter(Boolean)
      : (request.awb || request.awbNumber ? [String(request.awb || request.awbNumber).trim()] : []);
    const ref = request.orderReference ? String(request.orderReference).trim() : null;
    if (!awbs.length && !ref) throw new Error('SHIPPING_PROVIDER_REQUEST_INVALID');
    if (awbs.length > 50) throw new Error('SHIPPING_PROVIDER_REQUEST_INVALID'); // doc: ≤ 50 waybills/call

    const query = awbs.length ? { waybill: awbs.join(',') } : { ref_ids: ref };
    const data = await this.#get('/api/v1/packages/json/', {
      timeoutMs: Math.max(Number(this.env.SHIPPING_PROVIDER_TIMEOUT_MS) || 5000, 10000),
      query,
      signal,
    });

    const parsed = parseTrackResponse(data); // throws SHIPPING_PROVIDER_RESPONSE_INVALID on garbage
    return {
      providerCode: this.providerCode,
      shipments: parsed.map((s) => ({
        awb: s.awb,
        orderReference: s.orderReference,
        currentStatus: {
          statusText: s.current.statusText,
          statusType: s.current.statusType,
          statusDateTime: normalizeDateTime(s.current.statusDateTime),
          locationText: s.current.locationText,
          instructions: s.current.instructions,
          nslCode: s.current.nslCode,
        },
        history: s.history.map((h) => ({
          statusText: h.statusText,
          statusType: h.statusType,
          statusDateTime: normalizeDateTime(h.statusDateTime),
          locationText: h.locationText,
          instructions: h.instructions,
          nslCode: h.nslCode,
        })),
      })),
    };
  }

  // ---- download document — GET /api/rest/fetch/pkg/document/ -----------
  // Slice 17: the PULL path for a proof document (EPOD / QC image / signature).
  // Provider-neutral: `{ awb, docType: 'EPOD'|'QC_IMAGE'|'SIGNATURE' }` in, a
  // URL (or `available: false`) out — never a fabricated link.
  async getDocuments(request, { signal } = {}) {
    const awb = String(request.awb || request.awbNumber || '');
    const mapped = DELHIVERY_DOC_TYPE[request.docType];
    if (!awb || !mapped) throw new Error('SHIPPING_PROVIDER_REQUEST_INVALID');

    const data = await this.#get('/api/rest/fetch/pkg/document/', {
      timeoutMs: Math.max(Number(this.env.SHIPPING_PROVIDER_TIMEOUT_MS) || 5000, 20000),
      query: { doc_type: mapped, waybill: awb },
      signal,
    });

    const parsed = parseDocumentResponse(data);
    if (!parsed.ok) {
      return { providerCode: this.providerCode, awb, docType: request.docType, available: false, url: null };
    }
    return {
      providerCode: this.providerCode,
      awb,
      docType: request.docType,
      available: true,
      url: parsed.url,
      source: 'PROVIDER',
      expiresAt: null, // provider-hosted links may expire — copy the bytes if long-term retention is needed
    };
  }

  // ---- NDR action — POST /api/p/update ------------------------------
  // A failed delivery attempt: tell the carrier to RE-ATTEMPT (forward) or
  // RESCHEDULE (reverse pickup). ASYNC — returns a UPL id to poll. Only
  // { waybill, act } is sent; an address / phone fix goes through editShipment.
  async submitNdrAction(request, { signal } = {}) {
    const awb = String(request.awb || request.awbNumber || '');
    let body;
    try { body = buildNdrUpdateBody({ awb, action: request.action }); }
    catch { throw new Error('SHIPPING_PROVIDER_REQUEST_INVALID'); }

    const data = await this.#post('/api/p/update', JSON.stringify(body), {
      timeoutMs: Math.max(Number(this.env.SHIPPING_PROVIDER_TIMEOUT_MS) || 5000, 15000), // P99 ~126s but this returns a UPL fast
      signal,
      ambiguousOnFailure: true, // a lost response after submit is genuinely unknown
    });

    const parsed = parseNdrUpdateResponse(data);
    if (!parsed.ok) {
      const e = new Error(parsed.code === 'PROVIDER_REJECTED' ? 'SHIPPING_PROVIDER_REJECTED' : 'SHIPPING_PROVIDER_RESPONSE_INVALID');
      e.providerReason = parsed.remark || null;
      throw e;
    }
    return {
      providerCode: this.providerCode,
      awb,
      action: request.action,
      uplId: parsed.uplId,
      status: 'SUBMITTED',
      submittedAt: new Date().toISOString(),
    };
  }

  // ---- NDR status — GET /api/cmu/get_bulk_upl/{UPL_ID}?verbose=true ----
  async getNdrStatus(request, { signal } = {}) {
    const uplId = String(request.uplId || '');
    if (!uplId) throw new Error('SHIPPING_PROVIDER_REQUEST_INVALID');

    const data = await this.#get(`/api/cmu/get_bulk_upl/${encodeURIComponent(uplId)}`, {
      timeoutMs: Math.max(Number(this.env.SHIPPING_PROVIDER_TIMEOUT_MS) || 5000, 15000),
      query: { verbose: 'true' },
      signal,
    });

    const { state, remark } = parseNdrStatusResponse(data, request.awb || request.awbNumber || null);
    return {
      providerCode: this.providerCode,
      uplId,
      state, // PENDING | ACCEPTED | REJECTED | UNKNOWN
      providerRemark: remark || null,
    };
  }
}

const MOT_FOR = Object.freeze({ STANDARD: 'S', SURFACE: 'S', EXPRESS: 'E', NDD: 'N' });

// Accepts Delhivery's real shape `{ delivery_codes: [ { postal_code: {...} } ] }`
// and, defensively, a bare array. Returns null for anything unparseable.
function normalizeDeliveryCodes(data) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.delivery_codes)) return data.delivery_codes;
  return null;
}

// The TAT / charges responses are not field-specified in the supplied doc.
// Pull out the record that carries the numbers without assuming a wrapper shape.
function firstRecord(data) {
  if (Array.isArray(data)) return data[0] && typeof data[0] === 'object' ? data[0] : {};
  if (data && typeof data === 'object') {
    if (Array.isArray(data.data)) return data.data[0] && typeof data.data[0] === 'object' ? data.data[0] : {};
    if (data.data && typeof data.data === 'object') return data.data;
    return data;
  }
  return {};
}
function firstNumber(node, keys) {
  for (const k of keys) {
    const v = node?.[k];
    const n = typeof v === 'string' ? Number(v) : v;
    if (typeof n === 'number' && Number.isFinite(n)) return n;
  }
  return null;
}
function firstString(node, keys) {
  for (const k of keys) {
    const v = node?.[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}
// /api/p/edit response is not field-specced: an explicit failure flag or error
// string ⇒ NO; otherwise (2xx, no failure signal) ⇒ YES.
function parseEditOk(data) {
  if (data == null || typeof data !== 'object') return false;
  if (data.success === false || data.status === false) return false;
  if (data.success === true || String(data.status || '').toLowerCase() === 'success') return true;
  if (firstString(data, ['error', 'errors'])) return false;
  const pkg = Array.isArray(data.packages) ? data.packages[0] : null;
  if (pkg && pkg.success === false) return false;
  return true;
}
function safeRemark(data) {
  return firstString(data, ['rmk', 'remark', 'remarks', 'message', 'error'])
    || firstString(Array.isArray(data?.packages) ? data.packages[0] : null, ['remarks', 'remark', 'rmk']);
}
function normalizeDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}
// Tracking scans need the full timestamp, not just the date. Keep the parsed
// ISO instant; if it does not parse, pass the original through unchanged so the
// caller (shipmentEventService) can reject it rather than us silently dropping.
function normalizeDateTime(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? String(value) : d.toISOString();
}
