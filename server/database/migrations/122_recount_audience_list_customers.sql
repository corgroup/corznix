-- Audience lists imported before the fix counted every row matched to a
-- customer, including DUPLICATE and INVALID rows, so the import preview showed
-- "existing customers 2, new contacts -1" for a file with one valid row
-- (production, 2026-09-17). New imports count VALID rows only; this brings the
-- stored count of every earlier list onto the same rule. Idempotent.
UPDATE marketing_audience_lists l
   SET l.existing_customer_rows = (
     SELECT COUNT(*) FROM marketing_audience_contacts c
      WHERE c.list_id = l.id
        AND c.customer_id IS NOT NULL
        AND c.import_status = 'VALID'
   );
