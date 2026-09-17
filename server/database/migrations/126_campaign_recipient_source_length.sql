-- marketing_campaign_recipients.source was VARCHAR(40), but a source is
-- "LIST:<uuid>" (41 chars) or "SEGMENT:<uuid>" (44). Recipients are written
-- with INSERT IGNORE, so MySQL truncated the value silently instead of
-- failing, and the audience report could not name the list a recipient came
-- from. Rows already written keep their truncated value (the CMS matches them
-- by prefix); new rows store the full source.
ALTER TABLE marketing_campaign_recipients MODIFY source VARCHAR(80) NOT NULL;
