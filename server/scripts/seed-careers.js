// Careers starter kit:
//   - 3 ACTIVE EMAIL templates: application ops notice, applicant
//     acknowledgement, and the reusable staff "direct message" template.
//   - one PUBLISHED sample job posting, so the CMS Careers section and the
//     storefront /careers page have something real to show immediately.
//
// Idempotent. Run:  npm run seed:careers
import { pool, query } from '../src/database/connection/pool.js';
import { communicationRepository } from '../src/modules/communications/repository.js';
import { communicationTemplateService } from '../src/modules/communications/templateService.js';
import { careersAdminService } from '../src/modules/careers/adminService.js';
import {
  CAREERS_OPS_TEMPLATE_KEY, CAREERS_APPLICANT_TEMPLATE_KEY,
  CAREERS_OPS_TEMPLATE_DEFAULT, CAREERS_APPLICANT_TEMPLATE_DEFAULT,
  CAREERS_OPS_VARIABLE_SCHEMA, CAREERS_APPLICANT_VARIABLE_SCHEMA,
} from '../src/modules/careers/templates.js';

const DIRECT_MESSAGE_KEY = 'careers.direct_message';
const report = {};

async function ensureActiveTemplate(templateKey, def, variableSchema) {
  const existing = await communicationRepository.listTemplates();
  const active = existing.find((t) => t.template_key === templateKey && t.channel === 'EMAIL' && t.status === 'ACTIVE');
  if (active) { report[templateKey] = 'already ACTIVE'; return; }
  const t = await communicationTemplateService.create({
    templateKey, channel: 'EMAIL', classification: 'TRANSACTIONAL',
    subject: def.subject, bodyTemplate: def.bodyTemplate, variableSchema,
  });
  await communicationTemplateService.setStatus({ id: t.id, status: 'ACTIVE' });
  report[templateKey] = `created + activated v${t.version}`;
}

try {
  await ensureActiveTemplate(CAREERS_OPS_TEMPLATE_KEY, CAREERS_OPS_TEMPLATE_DEFAULT, CAREERS_OPS_VARIABLE_SCHEMA);
  await ensureActiveTemplate(CAREERS_APPLICANT_TEMPLATE_KEY, CAREERS_APPLICANT_TEMPLATE_DEFAULT, CAREERS_APPLICANT_VARIABLE_SCHEMA);
  await ensureActiveTemplate(DIRECT_MESSAGE_KEY, {
    subject: '{{subject}}',
    bodyTemplate: '<div style="white-space:pre-wrap; font-family: -apple-system, Segoe UI, Roboto, sans-serif;">{{message}}</div>',
  }, { subject: { required: true, type: 'string' }, message: { required: true, type: 'string' } });

  const [existingJob] = await query("SELECT id FROM career_jobs WHERE slug = 'customer-experience-associate'");
  if (!existingJob) {
    const job = await careersAdminService.createJob({
      title: 'Customer Experience Associate',
      slug: 'customer-experience-associate',
      department: 'Customer Experience',
      location: 'Remote (India)',
      employmentType: 'FULL_TIME',
      summary: 'Own the first response for CORCOTTON customers across email, WhatsApp and order support.',
      description: 'We\'re looking for a Customer Experience Associate to help CORCOTTON customers have a great post-purchase experience — answering questions, resolving order and delivery issues, and working closely with our warehouse and logistics teams.',
      responsibilities: [
        'Respond to customer queries over email and WhatsApp within our SLA',
        'Resolve order, delivery and return issues end-to-end',
        'Coordinate with the warehouse team on delivery exceptions',
        'Keep internal notes and status updates current in the CMS',
      ],
      requirements: [
        '1-3 years in a customer support or e-commerce operations role',
        'Clear written communication in English and Hindi',
        'Comfortable working independently in a remote, async-first team',
      ],
      status: 'PUBLISHED',
    }, null);
    report.sampleJob = `created "${job.slug}" (PUBLISHED)`;
  } else {
    report.sampleJob = 'already exists';
  }

  console.log('\nCareers starter kit\n');
  console.log(JSON.stringify(report, null, 2));
  console.log('\nStorefront: /careers · /careers/customer-experience-associate');
  console.log('CMS: Careers → Job Postings / Applications\n');
} finally {
  await pool.end();
}
