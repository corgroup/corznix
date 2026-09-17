import { Router } from 'express';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { AppError } from '../../utils/errors.js';
import { careersService } from './service.js';

// Public storefront Careers surface — anonymous by design, no login. Mirrors
// the newsletter/support public-route shape (thin router, service owns rules).
const router = Router();

const applyLimiter = rateLimit({
  windowMs: 60_000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: 'RATE_LIMITED', message: 'Too many applications submitted. Please try again shortly.' } },
});

// One PDF resume, up to 5 MB. No DOC/DOCX — a single well-understood format
// keeps parsing/malware surface small and is what almost every ATS asks for.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, file.mimetype === 'application/pdf'),
});

const listQuery = z.object({ department: z.string().trim().max(80).optional(), location: z.string().trim().max(120).optional() });
const applyBody = z.object({
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().min(1).max(80),
  email: z.string().trim().min(3).max(255),
  phone: z.string().trim().min(6).max(32),
  portfolioUrl: z.string().trim().max(500).optional(),
  linkedinUrl: z.string().trim().max(500).optional(),
  coverNote: z.string().trim().max(4000).optional(),
});

router.get('/jobs', async (req, res, next) => {
  try {
    const q = listQuery.parse(req.query ?? {});
    res.json({ data: { jobs: await careersService.listPublished(q) } });
  } catch (err) { next(err); }
});

router.get('/jobs/:slug', async (req, res, next) => {
  try { res.json({ data: await careersService.getPublished(req.params.slug) }); } catch (err) { next(err); }
});

router.post('/jobs/:slug/apply', applyLimiter, upload.single('resume'), async (req, res, next) => {
  try {
    const fields = applyBody.parse(req.body ?? {});
    if (!req.file) return next(new AppError('VALIDATION_ERROR', 'A resume (PDF) is required.', 400));
    const result = await careersService.submitApplication({
      slug: req.params.slug, fields,
      resume: { buffer: req.file.buffer, mimetype: req.file.mimetype, originalname: req.file.originalname },
    });
    res.status(201).json({ data: result });
  } catch (err) { next(err); }
});

export default router;
