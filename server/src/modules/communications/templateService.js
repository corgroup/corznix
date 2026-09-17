import { AppError } from '../../utils/errors.js';
import { communicationRepository } from './repository.js';
import { placeholdersIn, renderTemplate } from './templateRenderer.js';

const KEY = /^[a-z][a-z0-9_.]{2,79}$/;

const dto = (t) => ({
  id: t.id, templateKey: t.template_key, channel: t.channel, classification: t.classification,
  version: Number(t.version), status: t.status, subject: t.subject ?? null,
  bodyTemplate: t.body_template, variableSchema: typeof t.variable_schema === 'string' ? JSON.parse(t.variable_schema) : t.variable_schema,
  providerTemplateRef: t.provider_template_ref ?? null, createdAt: t.created_at, updatedAt: t.updated_at,
});

/**
 * Communication templates (§127/§128). Templates are versioned and immutable
 * once created — a change is a new version; activating a version supersedes
 * the previous ACTIVE one for that (key, channel).
 */
export class CommunicationTemplateService {
  constructor({ repository = communicationRepository } = {}) {
    this.repository = repository;
  }

  async list(filters) {
    return (await this.repository.listTemplates(filters)).map(dto);
  }

  async detail(id) {
    const t = await this.repository.templateById(id);
    if (!t) throw new AppError('TEMPLATE_NOT_FOUND', 'Template not found.', 404);
    return dto(t);
  }

  #validate(input) {
    if (!KEY.test(String(input.templateKey || ''))) throw new AppError('VALIDATION_ERROR', 'templateKey must be a dotted lowercase slug.', 400);
    if (!['EMAIL', 'WHATSAPP'].includes(input.channel)) throw new AppError('VALIDATION_ERROR', 'channel must be EMAIL or WHATSAPP.', 400);
    if (!['TRANSACTIONAL', 'MARKETING'].includes(input.classification)) throw new AppError('VALIDATION_ERROR', 'classification must be TRANSACTIONAL or MARKETING.', 400);
    if (!input.bodyTemplate || String(input.bodyTemplate).trim().length < 3) throw new AppError('VALIDATION_ERROR', 'A body template is required.', 400);
    if (input.channel === 'EMAIL' && !input.subject) throw new AppError('VALIDATION_ERROR', 'Email templates need a subject.', 400);
    const schema = input.variableSchema || {};
    if (typeof schema !== 'object' || Array.isArray(schema)) throw new AppError('VALIDATION_ERROR', 'variableSchema must be an object.', 400);
    // Every placeholder in the body/subject must be declared.
    const declared = new Set(Object.keys(schema));
    for (const name of [...placeholdersIn(input.bodyTemplate), ...placeholdersIn(input.subject || '')]) {
      if (!declared.has(name)) throw new AppError('TEMPLATE_VARIABLE_INVALID', `Placeholder "{{${name}}}" is not declared in variableSchema.`, 400);
    }
    // A dry render with placeholder values proves the template is renderable.
    const sample = Object.fromEntries(Object.keys(schema).map((k) => [k, schema[k]?.type === 'number' ? 0 : `<${k}>`]));
    renderTemplate(input.bodyTemplate, schema, sample, { channel: input.channel });
    if (input.subject) renderTemplate(input.subject, schema, sample, { channel: input.channel });
  }

  async create(input) {
    this.#validate(input);
    const version = (await this.repository.maxTemplateVersion(input.templateKey, input.channel)) + 1;
    const t = await this.repository.insertTemplate({ ...input, version });
    return dto(t);
  }

  async setStatus({ id, status }) {
    if (!['DRAFT', 'ACTIVE', 'ARCHIVED'].includes(status)) throw new AppError('VALIDATION_ERROR', 'Invalid status.', 400);
    const t = await this.repository.templateById(id);
    if (!t) throw new AppError('TEMPLATE_NOT_FOUND', 'Template not found.', 404);
    if (status === 'ACTIVE') {
      // Supersede the current ACTIVE version for this (key, channel).
      const current = await this.repository.activeTemplate(null, t.template_key, t.channel);
      if (current && current.id !== id) await this.repository.updateTemplateStatus(current.id, 'ARCHIVED');
    }
    await this.repository.updateTemplateStatus(id, status);
    return this.detail(id);
  }
}

export const communicationTemplateService = new CommunicationTemplateService();
