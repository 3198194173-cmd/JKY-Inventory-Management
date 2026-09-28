import { database } from "./inventory-store";
import { stockScope, scopeInfo, type StockScope } from "./stock-scope";

export async function loadScope(owner: string): Promise<StockScope | null> {
  const row = await database().prepare("SELECT barcodes, label FROM stock_scopes WHERE owner = ?").bind(owner).first<{ barcodes: string; label: string }>();
  return row ? stockScope(row.barcodes, row.label) : null;
}
export async function saveScope(owner: string, barcodes: unknown, label: unknown) {
  const scope = stockScope(barcodes, label);
  await database().batch([
    database().prepare("INSERT INTO stock_scopes (owner, barcodes, label, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(owner) DO UPDATE SET barcodes = excluded.barcodes, label = excluded.label, updated_at = excluded.updated_at").bind(owner, scope.barcodes.join("\n"), scope.label, new Date().toISOString()),
    database().prepare("UPDATE alert_settings SET enabled = 0 WHERE owner = ?").bind(owner),
  ]);
  return scopeInfo(scope);
}
