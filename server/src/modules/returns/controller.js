import { returnEligibilityService } from './returnEligibilityService.js';
import { returnRequestService } from './returnRequestService.js';
import { differentStyleExchangeService } from './differentStyleExchangeService.js';
import { exchangeCheckoutService } from './exchangeCheckoutService.js';
import * as v from './validation.js';

const ok = (res, data, status = 200) => res.status(status).json({ data });

export async function getEligibility(req, res, next) {
  try {
    const { orderId } = v.eligibilityQuery.parse({ orderId: req.query.orderId ?? req.params.orderId });
    ok(res, await returnEligibilityService.evaluateOrder({ customerId: req.customer.id, orderId }));
  } catch (err) { next(err); }
}

export async function createRequest(req, res, next) {
  try {
    const body = v.createRequestBody.parse(req.body ?? {});
    const result = await returnRequestService.createRequest({ customerId: req.customer.id, ...body });
    ok(res, result, 201);
  } catch (err) { next(err); }
}

export async function listRequests(req, res, next) {
  try {
    ok(res, { requests: await returnRequestService.listRequests(req.customer.id) });
  } catch (err) { next(err); }
}

export async function getRequest(req, res, next) {
  try {
    ok(res, await returnRequestService.getRequest(req.customer.id, req.params.id));
  } catch (err) { next(err); }
}

export async function cancelRequest(req, res, next) {
  try {
    ok(res, await returnRequestService.cancelRequest({ customerId: req.customer.id, requestId: req.params.id }));
  } catch (err) { next(err); }
}

export async function getExchangeContext(req, res, next) {
  try {
    ok(res, await differentStyleExchangeService.getContext({ customerId: req.customer.id, contextToken: req.params.token }));
  } catch (err) { next(err); }
}

export async function placeExchangeOrder(req, res, next) {
  try {
    const body = v.exchangeCheckoutBody.parse(req.body ?? {});
    const result = await exchangeCheckoutService.placeOrder({
      customerId: req.customer.id, contextToken: req.params.token, ...body,
    });
    ok(res, result, 201);
  } catch (err) { next(err); }
}

export async function cancelExchangeOrder(req, res, next) {
  try {
    ok(res, await exchangeCheckoutService.cancelOrder({ customerId: req.customer.id, orderId: req.params.id }));
  } catch (err) { next(err); }
}
