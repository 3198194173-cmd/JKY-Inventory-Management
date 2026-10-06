-- Upgrade complete warehouse queries rejected solely for a negative net result.
-- Preserve failed/partial queries, legacy product queries and inbound reversals.
UPDATE inbound_reconciliations
SET status='verified', error=NULL
WHERE query_scope='warehouse:v1' AND status='unresolved'
  AND inbound_quantity IS NOT NULL AND inbound_quantity NOT LIKE '-%'
  AND corrected_quantity LIKE '-%'
  AND error='入库冲销或其他库存变动尚未解释，仍需核对';
