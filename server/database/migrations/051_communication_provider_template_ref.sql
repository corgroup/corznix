-- WP-06 (real communication providers) — snapshot the template's
-- provider_template_ref onto the message at enqueue time, the same way
-- rendered_subject/rendered_body are already snapshotted. A WhatsApp send
-- through a real provider needs the APPROVED template identity at send
-- time; reading it fresh from communication_templates at dispatch would
-- make the message's provider behaviour depend on the template row still
-- existing/being unchanged after enqueue, breaking the "message identity is
-- immutable once created" rule communication_messages already follows for
-- every other rendered field.
ALTER TABLE communication_messages
  ADD COLUMN provider_template_ref VARCHAR(120) NULL AFTER template_version;
