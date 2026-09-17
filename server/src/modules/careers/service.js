import { randomUUID } from 'node:crypto';
import { AppError } from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';
import { env } from '../../config/index.js';
import { documentStorage } from '../documents/storage.js';
import { communicationService } from '../communications/service.js';
import { staffNotificationService } from '../staffNotifications/service.js';
import { careerJobRepository, careerApplicationRepository } from './repository.js';
import { CAREERS_OPS_TEMPLATE_KEY, CAREERS_APPLICANT_TEMPLATE_KEY } from './templates.js';

const log = logger('careers');
const stamp = () => new Date().toISOString().slice(0, 10).replaceAll('-', '');
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const jobPublicDto = (j) => ({
  id: j.id, slug: j.slug, title: j.title, department: j.department, location: j.location,
  employmentType: j.employmentType, summary: j.summary, description: j.description,
  responsibilities: j.responsibilities, requirements: j.requirements, postedAt: j.postedAt,
});

export class CareersService {
  async listPublished(filters) {
    return (await careerJobRepository.listPublished(filters)).map(jobPublicDto);
  }

  async getPublished(slug) {
    const job = await careerJobRepository.bySlug(slug, { publishedOnly: true });
    if (!job) throw new AppError('JOB_NOT_FOUND', 'That job posting is not available.', 404);
    return jobPublicDto(job);
  }

  /**
   * A candidate's submission — public, unauthenticated, real. Stores the
   * resume in the private document boundary (never a public/CDN path),
   * records the application, then best-effort (never throws back to the
   * candidate) fires: a staff notification (CMS bell) + an ops email + an
   * applicant acknowledgement email. Missing templates degrade to a quiet
   * no-op on the email side — the application itself is never lost.
   */
  async submitApplication({ slug, fields, resume }) {
    const job = await careerJobRepository.bySlug(slug, { publishedOnly: true });
    if (!job) throw new AppError('JOB_NOT_FOUND', 'That job posting is not available.', 404);

    const firstName = String(fields.firstName || '').trim();
    const lastName = String(fields.lastName || '').trim();
    const email = String(fields.email || '').trim().toLowerCase();
    const phone = String(fields.phone || '').trim();
    if (!firstName) throw new AppError('VALIDATION_ERROR', 'First name is required.', 400);
    if (!lastName) throw new AppError('VALIDATION_ERROR', 'Last name is required.', 400);
    if (!EMAIL_RE.test(email)) throw new AppError('VALIDATION_ERROR', 'A valid email is required.', 400);
    if (!phone || phone.length < 6) throw new AppError('VALIDATION_ERROR', 'A valid phone number is required.', 400);
    if (!resume?.buffer?.length) throw new AppError('VALIDATION_ERROR', 'A resume (PDF) is required.', 400);
    if (resume.mimetype !== 'application/pdf') throw new AppError('VALIDATION_ERROR', 'Resume must be a PDF.', 400);

    const key = documentStorage.newKey('pdf');
    const stored = await documentStorage.put(key, resume.buffer);

    const applicationNumber = `COR-APP-${stamp()}-${randomUUID().replaceAll('-', '').slice(0, 10).toUpperCase()}`;
    const application = await careerApplicationRepository.insert({
      applicationNumber, jobId: job.id, jobTitleSnapshot: job.title,
      firstName, lastName, email, phone,
      portfolioUrl: (fields.portfolioUrl || '').trim() || null,
      linkedinUrl: (fields.linkedinUrl || '').trim() || null,
      coverNote: (fields.coverNote || '').trim() || null,
      resumeStorageKey: stored.key, resumeFileName: (resume.originalname || 'resume.pdf').slice(0, 255), resumeByteSize: stored.byteSize,
    });

    await careerApplicationRepository.insertEvent({
      applicationId: application.id, eventType: 'APPLICATION_RECEIVED', toStatus: 'NEW',
    }).catch(() => {});

    await staffNotificationService.record({
      category: 'CAREERS', eventKey: 'CAREER_APPLICATION_RECEIVED', severity: 'INFO',
      title: `New application — ${job.title}`,
      body: `${firstName} ${lastName} · ${application.applicationNumber}`,
      link: `/careers/applications/${application.id}`, entityType: 'career_application', entityId: application.id,
      dedupeKey: `career_application:${application.id}`,
    }).catch((err) => log.warn('staff_notification_failed', { error: err.message }));

    const vars = {
      applicationNumber: application.applicationNumber, jobTitle: job.title,
      applicantName: `${firstName} ${lastName}`, applicantEmail: email, applicantPhone: phone,
    };
    const opsEmail = (env.CAREERS_NOTIFY_EMAIL || 'careers@corcotton.in').trim().toLowerCase();
    await communicationService.enqueue({
      businessEventId: `career_application_ops:${application.id}`, policyKey: 'careers.application_ops',
      classification: 'TRANSACTIONAL', channel: 'EMAIL', templateKey: CAREERS_OPS_TEMPLATE_KEY,
      recipient: { customerId: null, contactKey: opsEmail }, variables: vars,
    }).catch((err) => log.warn('ops_email_failed', { error: err.code || err.message }));

    await communicationService.enqueue({
      businessEventId: `career_application_ack:${application.id}`, policyKey: 'careers.application_ack',
      classification: 'TRANSACTIONAL', channel: 'EMAIL', templateKey: CAREERS_APPLICANT_TEMPLATE_KEY,
      recipient: { customerId: null, contactKey: email },
      variables: { applicationNumber: application.applicationNumber, jobTitle: job.title, applicantName: `${firstName} ${lastName}` },
    }).catch((err) => log.warn('applicant_email_failed', { error: err.code || err.message }));

    return { applicationNumber: application.applicationNumber };
  }
}

export const careersService = new CareersService();
