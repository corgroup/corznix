// Default copy for the two Careers emails. Seeded (ACTIVE) by
// scripts/seed-careers.js — mirrors the owner-delivery / abandoned-cart
// pattern: TEMPLATE_DEFAULTS is starter content, not auto-wired; a template
// only sends once it exists as an ACTIVE row.

export const CAREERS_OPS_TEMPLATE_KEY = 'careers.application_ops';
export const CAREERS_APPLICANT_TEMPLATE_KEY = 'careers.application_ack';

export const CAREERS_OPS_VARIABLE_SCHEMA = {
  applicationNumber: { required: true, type: 'string' },
  jobTitle: { required: true, type: 'string' },
  applicantName: { required: true, type: 'string' },
  applicantEmail: { required: true, type: 'string' },
  applicantPhone: { required: true, type: 'string' },
};
export const CAREERS_APPLICANT_VARIABLE_SCHEMA = {
  applicationNumber: { required: true, type: 'string' },
  jobTitle: { required: true, type: 'string' },
  applicantName: { required: true, type: 'string' },
};

export const CAREERS_OPS_TEMPLATE_DEFAULT = {
  subject: 'New job application — {{jobTitle}} ({{applicationNumber}})',
  bodyTemplate:
    '<p>A new application was submitted.</p>'
    + '<p><strong>Role:</strong> {{jobTitle}}<br>'
    + '<strong>Applicant:</strong> {{applicantName}}<br>'
    + '<strong>Email:</strong> {{applicantEmail}}<br>'
    + '<strong>Phone:</strong> {{applicantPhone}}<br>'
    + '<strong>Reference:</strong> {{applicationNumber}}</p>'
    + '<p>Review it in the CMS under Careers → Applications.</p>',
};
export const CAREERS_APPLICANT_TEMPLATE_DEFAULT = {
  subject: 'We received your application — {{jobTitle}}',
  bodyTemplate:
    '<p>Hi {{applicantName}},</p>'
    + '<p>Thanks for applying to <strong>{{jobTitle}}</strong> at CORCOTTON. '
    + 'We\'ve received your application (reference <strong>{{applicationNumber}}</strong>) and our team will review it shortly.</p>'
    + '<p>— The CORCOTTON team</p>',
};
