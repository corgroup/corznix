import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { authenticate } from '../../middleware/authenticate.js';
import { AppError } from '../../utils/errors.js';
import {
  supportService, SupportService,
  SUPPORT_ATTACHMENT_MAX_BYTES, SUPPORT_ATTACHMENT_MAX_COUNT,
} from './service.js';

// Customer support surface. Every route is scoped to req.customer — a
// customer only ever sees their own tickets and only CUSTOMER-visible
// messages (§52/§56).
const router = Router();
router.use(authenticate);

// Attachments arrive as multipart, so these routes accept BOTH shapes: a
// plain JSON body when there is nothing to attach, and multipart when there
// is. multer only populates req.files for multipart requests and leaves a
// JSON body to the normal parser, so one handler serves both.
//
// The byte limit is enforced here as well as in the service: multer stops
// reading at the limit, which is what keeps an oversized upload from being
// buffered in memory at all, while the service check is what a non-HTTP
// caller still has to pass.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: SUPPORT_ATTACHMENT_MAX_BYTES, files: SUPPORT_ATTACHMENT_MAX_COUNT },
});

// multer's own errors are terse ("File too large") and carry no status, so
// they would surface as a 500. Translate them into the same shape every other
// validation failure uses.
const attach = (field) => (req, res, next) => upload.array(field, SUPPORT_ATTACHMENT_MAX_COUNT)(req, res, (err) => {
  if (!err) return next();
  if (err.code === 'LIMIT_FILE_SIZE') return next(new AppError('VALIDATION_ERROR', 'Each file must be 10 MB or smaller.', 400));
  if (err.code === 'LIMIT_FILE_COUNT') return next(new AppError('VALIDATION_ERROR', `You can attach at most ${SUPPORT_ATTACHMENT_MAX_COUNT} files.`, 400));
  if (err.code === 'LIMIT_UNEXPECTED_FILE') return next(new AppError('VALIDATION_ERROR', 'Unexpected file field.', 400));
  return next(err);
});

const createBody = z.object({
  category: z.enum(['GENERAL', 'ORDER', 'DELIVERY', 'PAYMENT', 'RETURN', 'EXCHANGE', 'PRODUCT']),
  subject: z.string().trim().min(3).max(200),
  body: z.string().trim().min(3).max(5000),
  orderId: z.string().trim().min(1).optional(),
  returnRequestId: z.string().trim().min(1).optional(),
  idempotencyKey: z.string().trim().min(8).max(120),
});
const replyBody = z.object({ body: z.string().trim().min(1).max(5000) });

// A multipart field that was left blank arrives as "" rather than absent,
// which an .optional() string would happily accept as a linked order id.
const dropBlanks = (body) => Object.fromEntries(
  Object.entries(body ?? {}).filter(([, v]) => v !== '' && v !== undefined),
);

router.get('/tickets', async (req, res, next) => {
  try { res.json({ data: { tickets: await supportService.listTickets(req.customer.id) } }); } catch (err) { next(err); }
});

router.post('/tickets', attach('attachments'), async (req, res, next) => {
  try {
    const body = createBody.parse(dropBlanks(req.body));
    const attachments = SupportService.assertAttachments(req.files);
    res.status(201).json({ data: await supportService.createTicket({ customerId: req.customer.id, ...body, attachments }) });
  } catch (err) { next(err); }
});

router.get('/tickets/:id', async (req, res, next) => {
  try { res.json({ data: await supportService.getTicket(req.customer.id, req.params.id) }); } catch (err) { next(err); }
});

router.post('/tickets/:id/messages', attach('attachments'), async (req, res, next) => {
  try {
    const { body } = replyBody.parse(dropBlanks(req.body));
    const attachments = SupportService.assertAttachments(req.files);
    res.status(201).json({ data: await supportService.reply({ customerId: req.customer.id, idOrNumber: req.params.id, body, attachments }) });
  } catch (err) { next(err); }
});

// The only way to read an attachment. There is no public URL and no
// predictable path — the id is checked against the asking customer's own
// tickets before a single byte is read from storage.
//
// Served inline for a preview but with nosniff and an explicit filename, so a
// file the browser would rather interpret than display cannot be turned into
// something executable in our origin.
router.get('/attachments/:attachmentId', async (req, res, next) => {
  try {
    const file = await supportService.attachment(req.customer.id, req.params.attachmentId);
    res.setHeader('Content-Type', file.content_type);
    res.setHeader('Content-Length', file.byte_size);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', `inline; filename="${file.file_name.replace(/[^\w.\- ]+/g, '_')}"`);
    res.setHeader('Cache-Control', 'private, max-age=0, no-store');
    res.send(file.bytes);
  } catch (err) { next(err); }
});

export default router;
