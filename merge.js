// PURE merge rules (no database, no network) so they can be unit-tested. This is the heart of sync.
//
// Table kinds:
//   append     immutable events (upload once, duplicates ignored)
//   ledger     stock events: merged by ADDING, never by overwriting. -10 on A and -7 on B = -17
//   status     sales: status only moves forward (calculated -> confirmed -> corrected)
//   lww        tiny reference data (categories): newest edit wins
//   conflict   review records: open -> resolved, never back
//   versioned  products: field-by-field three-way merge; a true conflict is recorded, never overwritten
export const META = ['name', 'sku', 'barcode', 'category_id', 'buy_price', 'sell_price', 'low_stock_threshold', 'supplier', 'description', 'image_ref', 'active'];
// Order matters: parents before children, so a partial sync never leaves an orphan.
export const TABLES = [
  { name: 'categories', kind: 'lww', cols: ['name'] },
  { name: 'products', kind: 'versioned', cols: META }, // NOTE: quantity is deliberately NOT synced; it is derived from the ledger
  { name: 'sales', kind: 'status', cols: ['receipt_no', 'user_id', 'status', 'total', 'corrects_sale_id', 'correction_reason'] },
  { name: 'sale_items', kind: 'append', cols: ['sale_id', 'product_id', 'product_name', 'quantity', 'unit_price', 'subtotal', 'unit_cost'] },
  { name: 'calculations', kind: 'append', cols: ['user_id', 'expression', 'result'] },
  { name: 'invoices', kind: 'append', cols: ['supplier', 'invoice_no', 'invoice_date', 'image_ref', 'ocr_text', 'status', 'total', 'user_id'] },
  { name: 'invoice_items', kind: 'append', cols: ['invoice_id', 'product_id', 'name', 'quantity', 'unit_price', 'total', 'is_new_product'] },
  { name: 'inventory_transactions', kind: 'ledger', cols: ['product_id', 'delta', 'reason', 'ref_id', 'note', 'user_id'] },
  { name: 'audit_logs', kind: 'append', cols: ['user_id', 'action', 'old_value', 'new_value', 'reason'] },
  { name: 'sync_conflicts', kind: 'conflict', cols: ['kind', 'table_name', 'row_id', 'field', 'local_value', 'remote_value', 'detail', 'status', 'resolution', 'resolved_by', 'resolved_at'] },
];

const norm = (v) => (v === undefined ? null : v);
const same = (a, b) => norm(a) === norm(b);
export const pick = (row, fields) => Object.fromEntries(fields.map(f => [f, norm(row[f])]));
export const isoTs = (v) => (v ? new Date(v).toISOString() : v); // cloud returns +00:00, local uses Z: normalise so string comparisons work

// base = the row as it was at the last sync. Only a field BOTH sides changed differently is a conflict.
// With no base (unknown history) every difference is treated as a conflict, so nothing is overwritten silently.
export function threeWayMerge(base, local, remote, fields = META) {
  const merged = {}, conflicts = [];
  for (const f of fields) {
    const l = norm(local[f]), r = norm(remote[f]);
    if (same(l, r)) { merged[f] = l; continue; }
    if (base) {
      const b = norm(base[f]);
      if (same(l, b)) { merged[f] = r; continue; } // only the other device changed it
      if (same(r, b)) { merged[f] = l; continue; } // only this device changed it
    }
    merged[f] = l; conflicts.push({ field: f, local: l, remote: r });
  }
  return { merged, conflicts };
}

export const STATUS_RANK = { calculated: 1, confirmed: 2, corrected: 3, voided: 3 };
export const mergeStatus = (a, b) => ((STATUS_RANK[b] || 0) > (STATUS_RANK[a] || 0) ? b : a);

export const toCloudRow = (T, r, biz) => ({ id: r.id, business_id: biz, device_id: r.device_id ?? null, created_at: r.created_at, updated_at: r.updated_at, ...pick(r, T.cols) });
export function fromCloudRow(r) { const { business_id, synced_at, ...rest } = r; return { ...rest, created_at: isoTs(r.created_at), updated_at: isoTs(r.updated_at), ...(r.resolved_at ? { resolved_at: isoTs(r.resolved_at) } : {}) }; }

// What to do with a product that arrived from the cloud.
export function planProductPull(local, remote) {
  const rm = pick(remote, META);
  if (!local) return { action: 'insert', meta: rm };
  if (remote.version <= local.base_version) return { action: 'skip' };            // already have this version
  if (local.sync_status === 'SYNCED') return { action: 'take', meta: rm };        // no unsent edits: just accept
  const base = local.base_json ? JSON.parse(local.base_json) : null;
  const { merged, conflicts } = threeWayMerge(base, pick(local, META), rm);
  return conflicts.length ? { action: 'conflict', meta: merged, remoteMeta: rm, conflicts } : { action: 'merge', meta: merged, remoteMeta: rm };
}
