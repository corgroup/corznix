import { randomUUID } from 'node:crypto';
import { AppError } from '../../utils/errors.js';
import { slugify, isValidSlug } from '../../utils/slug.js';
import { documentStorage } from '../documents/storage.js';
import { communicationService } from '../communications/service.js';
import { careerJobRepository, careerApplicationRepository } from './repository.js';

const STATUS_ORDER = ['NEW', 'UNDER_REVIEW', 'SHORTLISTED', 'INTERVIEW', 'SELECTED', 'REJECTED'];
const JOB_STATUSES = ['DRAFT', 'PUBLISHED', 'CLOSED'];

export class CareersAdminService {
  // ---- job postings --------------------------------------------------
  listJobs(status) {
    return careerJobRepository.list({ status });
  }

  async getJob(id) {
    const job = await careerJobRepository.byId(id);
    if (!job) throw new AppError('JOB_NOT_FOUND', 'Job posting not found.', 404);
    return job;
  }

  async createJob(input, staffId) {
    if (!input.title || String(input.title).trim().length < 2) throw new AppError('VALIDATION_ERROR', 'A job title is required.', 400);
    if (!input.description || String(input.description).trim().length < 10) throw new AppError('VALIDATION_ERROR', 'A description is required.', 400);
    let slug = input.slug ? slugify(input.slug) : slugify(input.title);
    if (!isValidSlug(slug)) throw new AppError('VALIDATION_ERROR', 'Could not derive a valid slug from the title.', 400);
    if (await careerJobRepository.slugExists(slug)) {
      // Deterministic disambiguation rather than a hard reject — a second
      // "Sales Associate" posting is a normal thing to create.
      slug = `${slug}-${Date.now().toString(36).slice(-5)}`;
    }
    return careerJobRepository.insert({ ...input, slug }, staffId);
  }

  async updateJob(id, patch) {
    await this.getJob(id);
    return careerJobRepository.update(id, patch);
  }

  async setJobStatus(id, status) {
    if (!JOB_STATUSES.includes(status)) throw new AppError('VALIDATION_ERROR', `status must be one of ${JOB_STATUSES.join(', ')}.`, 400);
    await this.getJob(id);
    return careerJobRepository.setStatus(id, status);
  }

  // ---- applications ----------------------------------------------------
  listApplications(filters) {
    return careerApplicationRepository.list(filters);
  }

  facets() {
    return careerApplicationRepository.facets();
  }

  async getApplication(id) {
    const app = await careerApplicationRepository.byId(id);
    if (!app) throw new AppError('APPLICATION_NOT_FOUND', 'Application not found.', 404);
    const events = await careerApplicationRepository.events(id);
    return { ...app, events };
  }

  async resumeFile(id) {
    const app = await careerApplicationRepository.byId(id);
    if (!app) throw new AppError('APPLICATION_NOT_FOUND', 'Application not found.', 404);
    const bytes = await documentStorage.get(app.resumeStorageKey);
    return { bytes, fileName: app.resumeFileName };
  }

  async setStatus({ id, status, actor }) {
    if (!STATUS_ORDER.includes(status)) throw new AppError('VALIDATION_ERROR', `status must be one of ${STATUS_ORDER.join(', ')}.`, 400);
    const app = await careerApplicationRepository.byId(id);
    if (!app) throw new AppError('APPLICATION_NOT_FOUND', 'Application not found.', 404);
    if (app.status === status) return app;
    const updated = await careerApplicationRepository.setStatus(id, status);
    await careerApplicationRepository.insertEvent({
      applicationId: id, eventType: 'STATUS_CHANGED', fromStatus: app.status, toStatus: status, staffId: actor?.id || null,
    }).catch(() => {});
    return updated;
  }

  async addNote({ id, note, actor }) {
    if (!note || !note.trim()) throw new AppError('VALIDATION_ERROR', 'A note is required.', 400);
    const app = await careerApplicationRepository.byId(id);
    if (!app) throw new AppError('APPLICATION_NOT_FOUND', 'Application not found.', 404);
    await careerApplicationRepository.insertEvent({
      applicationId: id, eventType: 'NOTE_ADDED', note: note.trim(), staffId: actor?.id || null,
    });
    return this.getApplication(id);
  }

  async assign({ id, staffId, expectedVersion, actor }) {
    const updated = await careerApplicationRepository.assign(id, staffId, expectedVersion);
    if (!updated) throw new AppError('ASSIGNMENT_VERSION_CONFLICT', 'This application was reassigned by someone else. Reload and try again.', 409);
    await careerApplicationRepository.insertEvent({
      applicationId: id, eventType: 'ASSIGNED', staffId: actor?.id || null, detail: { assignedTo: staffId },
    }).catch(() => {});
    return updated;
  }

  /**
   * Contact an applicant directly from the CMS — a genuinely free-text,
   * staff-composed email (not one of the fixed lifecycle templates). Uses a
   * single reusable "direct message" template whose body is just
   * `{{message}}` inside a `white-space:pre-wrap` wrapper, so the staff
   * member's line breaks render correctly without any double-escaping. Each
   * send gets a fresh businessEventId — this is a real, repeatable action,
   * never deduped against a previous message to the same applicant.
   */
  async sendEmail({ id, subject, message, actor }) {
    if (!subject || !subject.trim()) throw new AppError('VALIDATION_ERROR', 'A subject is required.', 400);
    if (!message || !message.trim()) throw new AppError('VALIDATION_ERROR', 'A message is required.', 400);
    const app = await careerApplicationRepository.byId(id);
    if (!app) throw new AppError('APPLICATION_NOT_FOUND', 'Application not found.', 404);

    const result = await communicationService.enqueue({
      businessEventId: `career_direct_message:${id}:${randomUUID()}`,
      policyKey: 'careers.direct_message', classification: 'TRANSACTIONAL', channel: 'EMAIL',
      templateKey: 'careers.direct_message',
      recipient: { customerId: null, contactKey: app.email },
      variables: { subject: subject.trim(), message: message.trim() },
    });

    await careerApplicationRepository.insertEvent({
      applicationId: id, eventType: 'EMAIL_SENT', staffId: actor?.id || null,
      detail: { subject: subject.trim(), messageId: result.id },
    }).catch(() => {});
    return this.getApplication(id);
  }
}

export const careersAdminService = new CareersAdminService();
