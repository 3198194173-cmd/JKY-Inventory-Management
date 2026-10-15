ALTER TABLE inbound_reconciliations ADD COLUMN transfer_outbound_quantity TEXT NOT NULL DEFAULT '0';
ALTER TABLE inbound_reconciliations ADD COLUMN transfer_outbound_records TEXT NOT NULL DEFAULT '[]';
