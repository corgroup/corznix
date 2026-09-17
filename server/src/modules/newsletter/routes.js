import { Router } from 'express';
import { z } from 'zod';
import { newsletterService } from './service.js';

// Public storefront newsletter surface — anonymous by design (a signup never
// creates a customer account, §37).
const router = Router();

// One of email / phone, matching the channel. Enforced here rather than in
// the service so a malformed request is a 400 before any work happens.
const subscribeBody = z.object({
  channel: z.enum(['EMAIL', 'WHATSAPP']).optional(),
  email: z.string().trim().min(3).max(255).optional(),
  phone: z.string().trim().min(8).max(20).optional(),
  source: z.enum(['FOOTER_NEWSLETTER', 'CHECKOUT', 'PROMOTION_FORM', 'ACCOUNT_SETTINGS']).optional(),
}).superRefine((v, ctx) => {
  const channel = v.channel || 'EMAIL';
  if (channel === 'WHATSAPP' && !v.phone) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['phone'], message: 'A mobile number is required for a WhatsApp subscription.' });
  }
  if (channel === 'EMAIL' && !v.email) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['email'], message: 'An email address is required.' });
  }
});
const tokenBody = z.object({ token: z.string().trim().min(16).max(128) });
const unsubBody = z.object({
  email: z.string().trim().min(3).max(255).optional(),
  token: z.string().trim().min(16).max(128).optional(),
});

router.post('/subscribe', async (req, res, next) => {
  try {
    const { email, phone, channel, source } = subscribeBody.parse(req.body ?? {});
    res.status(201).json({
      data: await newsletterService.subscribe({
        email, phone, channel: channel || 'EMAIL', source: source || 'FOOTER_NEWSLETTER',
      }),
    });
  } catch (err) { next(err); }
});

router.post('/confirm', async (req, res, next) => {
  try {
    const { token } = tokenBody.parse(req.body ?? {});
    res.json({ data: await newsletterService.confirm(token) });
  } catch (err) { next(err); }
});

router.post('/unsubscribe', async (req, res, next) => {
  try {
    const body = unsubBody.parse(req.body ?? {});
    if (!body.email && !body.token) throw Object.assign(new Error('An email or token is required.'), { code: 'VALIDATION_ERROR', status: 400 });
    res.json({ data: await newsletterService.unsubscribe({ ...body, source: 'UNSUBSCRIBE_LINK' }) });
  } catch (err) { next(err); }
});

export default router;
