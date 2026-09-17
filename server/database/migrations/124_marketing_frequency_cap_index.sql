-- Marketing frequency cap: before a campaign messages someone, it checks
-- whether that address already received a marketing message on the channel
-- recently. That lookup is per recipient, so it needs an index — without one
-- every recipient of every batch scans the whole message table.
ALTER TABLE communication_messages
  ADD KEY idx_comm_messages_recipient_recent (recipient_contact_key, channel, created_at);
