import { Router } from 'express';
import { z } from 'zod';
import { requireStaffPermission } from '../../middleware/requireStaffPermission.js';
import { PERMISSIONS } from '../staff/permissions.js';
import { StaffAuditRepository } from '../staff/repositories.js';
import { careersAdminService } from './adminService.js';

// CMS Careers → Job Postings + Applications. `.read` covers browsing jobs and
// opening an application (including the resume — never a broader gate);
// `.manage` covers everything that changes state (create/publish/status/
// assign/notes/outbound email).
const audit = new StaffAuditRepository();
const router = Router();
const read = requireStaffPermission(PERMISSIONS.CAREERS_READ);
const manage = requireStaffPermission(PERMISSIONS.CAREERS_MANAGE);

const actorOf = (req) => ({ id: req.staff?.id, email: req.staff?.email, ip: req.ip, requestId: req.id });
const log = (req, action, id, metadata = null) => audit.log({
  staffUserId: req.staff.id, actorEmail: req.staff.email, action,
  resourceType: 'career', resourceId: id ? String(id) : null, metadata, ipAddress: req.ip,
});

const jobBody = z.object({
  title: z.string().trim().min(2).max(160),
  slug: z.string().trim().max(160).optional(),
  department: z.string().trim().max(80).optional(),
  location: z.string().trim().max(120).optional(),
  employmentType: z.enum(['FULL_TIME', 'PART_TIME', 'CONTRACT', 'INTERNSHIP']).optional(),
  summary: z.string().trim().max(300).optional(),
  description: z.string().trim().min(10),
  responsibilities: z.array(z.string().trim().min(1).max(300)).max(30).optional(),
  requirements: z.array(z.string().trim().min(1).max(300)).max(30).optional(),
  status: z.enum(['DRAFT', 'PUBLISHED', 'CLOSED']).optional(),
});
const jobPatchBody = jobBody.omit({ slug: true }).partial();

router.get('/careers/jobs', read, async (req, res, next) => {
  try {
    const status = ['DRAFT', 'PUBLISHED', 'CLOSED'].includes(req.query.status) ? req.query.status : null;
    res.json({ data: { jobs: await careersAdminService.listJobs(status) } });
  } catch (err) { next(err); }
});

router.post('/careers/jobs', manage, async (req, res, next) => {
  try {
    const job = await careersAdminService.createJob(jobBody.parse(req.body ?? {}), req.staff.id);
    await log(req, 'CAREER_JOB_CREATED', job.id, { title: job.title, status: job.status });
    res.status(201).json({ data: job });
  } catch (err) { next(err); }
});

router.get('/careers/jobs/:id', read, async (req, res, next) => {
  try { res.json({ data: await careersAdminService.getJob(req.params.id) }); } catch (err) { next(err); }
});

router.patch('/careers/jobs/:id', manage, async (req, res, next) => {
  try {
    const job = await careersAdminService.updateJob(req.params.id, jobPatchBody.parse(req.body ?? {}));
    await log(req, 'CAREER_JOB_UPDATED', req.params.id);
    res.json({ data: job });
  } catch (err) { next(err); }
});

router.post('/careers/jobs/:id/status', manage, async (req, res, next) => {
  try {
    const { status } = z.object({ status: z.enum(['DRAFT', 'PUBLISHED', 'CLOSED']) }).parse(req.body ?? {});
    const job = await careersAdminService.setJobStatus(req.params.id, status);
    await log(req, 'CAREER_JOB_STATUS_CHANGED', req.params.id, { status });
    res.json({ data: job });
  } catch (err) { next(err); }
});

// ---- applications ----------------------------------------------------
router.get('/careers/applications/facets', read, async (req, res, next) => {
  try { res.json({ data: { facets: await careersAdminService.facets() } }); } catch (err) { next(err); }
});

router.get('/careers/applications', read, async (req, res, next) => {
  try {
    const q = z.object({
      jobId: z.string().uuid().optional(),
      status: z.enum(['NEW', 'UNDER_REVIEW', 'SHORTLISTED', 'INTERVIEW', 'SELECTED', 'REJECTED']).optional(),
      q: z.string().trim().max(120).optional(),
      mine: z.coerce.boolean().optional(),
      limit: z.coerce.number().int().min(1).max(100).optional(),
      offset: z.coerce.number().int().min(0).optional(),
    }).parse(req.query ?? {});
    res.json({
      data: await careersAdminService.listApplications({
        jobId: q.jobId ?? null, status: q.status ?? null, q: q.q ?? null,
        assignedStaffId: q.mine ? req.staff.id : null, limit: q.limit ?? 50, offset: q.offset ?? 0,
      }),
    });
  } catch (err) { next(err); }
});

router.get('/careers/applications/:id', read, async (req, res, next) => {
  try { res.json({ data: await careersAdminService.getApplication(req.params.id) }); } catch (err) { next(err); }
});

router.get('/careers/applications/:id/resume', read, async (req, res, next) => {
  try {
    const { bytes, fileName } = await careersAdminService.resumeFile(req.params.id);
    await log(req, 'CAREER_RESUME_DOWNLOADED', req.params.id, { fileName });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${fileName.replace(/["\r\n]/g, '')}"`);
    res.send(bytes);
  } catch (err) { next(err); }
});

router.post('/careers/applications/:id/status', manage, async (req, res, next) => {
  try {
    const { status } = z.object({ status: z.enum(['NEW', 'UNDER_REVIEW', 'SHORTLISTED', 'INTERVIEW', 'SELECTED', 'REJECTED']) }).parse(req.body ?? {});
    const app = await careersAdminService.setStatus({ id: req.params.id, status, actor: actorOf(req) });
    await log(req, 'CAREER_APPLICATION_STATUS_CHANGED', req.params.id, { status });
    res.json({ data: app });
  } catch (err) { next(err); }
});

router.post('/careers/applications/:id/notes', manage, async (req, res, next) => {
  try {
    const { note } = z.object({ note: z.string().trim().min(1).max(4000) }).parse(req.body ?? {});
    const app = await careersAdminService.addNote({ id: req.params.id, note, actor: actorOf(req) });
    await log(req, 'CAREER_APPLICATION_NOTE_ADDED', req.params.id);
    res.json({ data: app });
  } catch (err) { next(err); }
});

router.post('/careers/applications/:id/assign', manage, async (req, res, next) => {
  try {
    const { staffId, expectedVersion } = z.object({ staffId: z.string().uuid().nullable(), expectedVersion: z.number().int().min(0) }).parse(req.body ?? {});
    const app = await careersAdminService.assign({ id: req.params.id, staffId, expectedVersion, actor: actorOf(req) });
    await log(req, 'CAREER_APPLICATION_ASSIGNED', req.params.id, { staffId });
    res.json({ data: app });
  } catch (err) { next(err); }
});

router.post('/careers/applications/:id/email', manage, async (req, res, next) => {
  try {
    const { subject, message } = z.object({ subject: z.string().trim().min(1).max(200), message: z.string().trim().min(1).max(8000) }).parse(req.body ?? {});
    const app = await careersAdminService.sendEmail({ id: req.params.id, subject, message, actor: actorOf(req) });
    await log(req, 'CAREER_APPLICATION_EMAILED', req.params.id, { subject });
    res.json({ data: app });
  } catch (err) { next(err); }
});

export default router;
