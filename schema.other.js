// Versioned migrations. Add new entries; never edit an applied one.
// Every synced table carries id (UUID), device_id, sync_status, created_at, updated_at.
const sync = `device_id TEXT, sync_status TEXT DEFAULT 'SYNC_PENDING', created_at TEXT NOT NULL, updated_at TEXT NOT NULL`;
export const MIGRATIONS = [
  { version: 1, sql: `
CREATE TABLE IF NOT EXISTS businesses(id TEXT PRIMARY KEY, name TEXT, phone TEXT, ${sync});
CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, business_id TEXT, full_name TEXT NOT NULL,
  username TEXT NOT NULL UNIQUE, role TEXT NOT NULL CHECK(role IN('admin','user')),
  pw_hash TEXT, pw_salt TEXT, permissions TEXT NOT NULL DEFAULT '{}', status TEXT DEFAULT 'active', ${sync});
CREATE TABLE IF NOT EXISTS devices(id TEXT PRIMARY KEY, business_id TEXT, name TEXT,
  status TEXT DEFAULT 'active', last_sync TEXT, ${sync});
CREATE TABLE IF NOT EXISTS pairing_codes(code TEXT PRIMARY KEY, business_id TEXT, expires_at TEXT NOT NULL, used INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT, updated_at TEXT);
CREATE TABLE IF NOT EXISTS audit_logs(id TEXT PRIMARY KEY, user_id TEXT, action TEXT NOT NULL,
  old_value TEXT, new_value TEXT, reason TEXT, ${sync});
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at);
INSERT OR IGNORE INTO settings(key,value) VALUES('negative_stock','false'),('auto_lock_minutes','2');` },
  { version: 2, sql: `
CREATE TABLE IF NOT EXISTS categories(id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, ${sync});
CREATE TABLE IF NOT EXISTS products(id TEXT PRIMARY KEY, name TEXT NOT NULL, sku TEXT, barcode TEXT, category_id TEXT,
  quantity REAL NOT NULL DEFAULT 0, buy_price REAL, sell_price REAL NOT NULL DEFAULT 0, low_stock_threshold REAL DEFAULT 0,
  supplier TEXT, description TEXT, image_ref TEXT, active INTEGER DEFAULT 1, ${sync});
CREATE INDEX IF NOT EXISTS idx_p_name ON products(name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_p_sku ON products(sku);
CREATE INDEX IF NOT EXISTS idx_p_barcode ON products(barcode);
CREATE TABLE IF NOT EXISTS calculations(id TEXT PRIMARY KEY, user_id TEXT, expression TEXT NOT NULL, result REAL, ${sync});
CREATE TABLE IF NOT EXISTS sales(id TEXT PRIMARY KEY, receipt_no TEXT, user_id TEXT, status TEXT NOT NULL DEFAULT 'calculated',
  total REAL NOT NULL, ${sync});
CREATE TABLE IF NOT EXISTS sale_items(id TEXT PRIMARY KEY, sale_id TEXT NOT NULL, product_id TEXT, product_name TEXT NOT NULL,
  quantity REAL NOT NULL, unit_price REAL NOT NULL, subtotal REAL NOT NULL, ${sync});
CREATE INDEX IF NOT EXISTS idx_sales_created ON sales(created_at);
CREATE INDEX IF NOT EXISTS idx_calc_created ON calculations(created_at);
CREATE INDEX IF NOT EXISTS idx_items_sale ON sale_items(sale_id);` },
  { version: 3, sql: `
CREATE TABLE IF NOT EXISTS inventory_transactions(id TEXT PRIMARY KEY, product_id TEXT NOT NULL, delta REAL NOT NULL,
  reason TEXT NOT NULL, ref_id TEXT, note TEXT, user_id TEXT, ${sync});
CREATE INDEX IF NOT EXISTS idx_inv_product ON inventory_transactions(product_id, created_at);
CREATE TABLE IF NOT EXISTS notifications(id TEXT PRIMARY KEY, type TEXT NOT NULL, title TEXT NOT NULL, body TEXT,
  ref_id TEXT, is_read INTEGER DEFAULT 0, ${sync});
-- Products created in Phase 2 had stock with no ledger row: give them an opening entry so the ledger matches the cached quantity.
INSERT INTO inventory_transactions(id,product_id,delta,reason,note,device_id,created_at,updated_at)
  SELECT lower(hex(randomblob(16))), id, quantity, 'opening', 'Opening stock', device_id, created_at, created_at FROM products WHERE quantity<>0;` },
  // Snapshot the buying price at the time of sale so profit reports stay correct after later price edits.
  { version: 4, sql: `ALTER TABLE sale_items ADD COLUMN unit_cost REAL;` },
  { version: 5, sql: `
CREATE TABLE IF NOT EXISTS invoices(id TEXT PRIMARY KEY, supplier TEXT, invoice_no TEXT, invoice_date TEXT, image_ref TEXT,
  ocr_text TEXT, status TEXT NOT NULL DEFAULT 'confirmed', total REAL, user_id TEXT, ${sync});
CREATE TABLE IF NOT EXISTS invoice_items(id TEXT PRIMARY KEY, invoice_id TEXT NOT NULL, product_id TEXT, name TEXT NOT NULL,
  quantity REAL NOT NULL, unit_price REAL NOT NULL, total REAL NOT NULL, is_new_product INTEGER DEFAULT 0, ${sync});
CREATE INDEX IF NOT EXISTS idx_inv_dup ON invoices(supplier, invoice_no);
CREATE INDEX IF NOT EXISTS idx_invitems_inv ON invoice_items(invoice_id);` },
  // Sync: the pending queue is sync_status='SYNC_PENDING' on each row (so a row and its queue entry can never disagree).
  { version: 6, sql: `
ALTER TABLE products ADD COLUMN base_version INTEGER NOT NULL DEFAULT 0; -- cloud version this device last saw
ALTER TABLE products ADD COLUMN base_json TEXT;                         -- product fields as of that version (for three-way merge)
CREATE TABLE IF NOT EXISTS sync_conflicts(id TEXT PRIMARY KEY, kind TEXT NOT NULL, table_name TEXT, row_id TEXT, field TEXT,
  local_value TEXT, remote_value TEXT, detail TEXT, status TEXT NOT NULL DEFAULT 'open', resolution TEXT, resolved_by TEXT,
  created_at TEXT NOT NULL, resolved_at TEXT);
CREATE INDEX IF NOT EXISTS idx_categories_sync ON categories(sync_status);
CREATE INDEX IF NOT EXISTS idx_products_sync ON products(sync_status);
CREATE INDEX IF NOT EXISTS idx_sales_sync ON sales(sync_status);
CREATE INDEX IF NOT EXISTS idx_sale_items_sync ON sale_items(sync_status);
CREATE INDEX IF NOT EXISTS idx_calculations_sync ON calculations(sync_status);
CREATE INDEX IF NOT EXISTS idx_invoices_sync ON invoices(sync_status);
CREATE INDEX IF NOT EXISTS idx_invoice_items_sync ON invoice_items(sync_status);
CREATE INDEX IF NOT EXISTS idx_inventory_transactions_sync ON inventory_transactions(sync_status);
CREATE INDEX IF NOT EXISTS idx_audit_logs_sync ON audit_logs(sync_status);` },
  // Repair: sales and sale items saved before this fix had the device id in sync_status (and 'SYNC_PENDING' in device_id),
  // so they would never have uploaded. Put them back in the queue with the right device.
  { version: 7, sql: `
UPDATE sales SET device_id=sync_status, sync_status='SYNC_PENDING' WHERE sync_status NOT IN ('SYNC_PENDING','SYNCED','CONFLICT','REJECTED');
UPDATE sale_items SET device_id=sync_status, sync_status='SYNC_PENDING' WHERE sync_status NOT IN ('SYNC_PENDING','SYNCED','CONFLICT','REJECTED');
` },
  // Corrections: the original sale is never edited. It is marked corrected/voided; the fixed version is a NEW sale linked back to it.
  { version: 8, sql: `
ALTER TABLE sales ADD COLUMN corrects_sale_id TEXT;
ALTER TABLE sales ADD COLUMN correction_reason TEXT;
CREATE INDEX IF NOT EXISTS idx_sales_corrects ON sales(corrects_sale_id);` },
  // Corrections never edit a sale: a correction is a NEW sale row (negative quantities) that points at the original.
  { version: 8, sql: `
ALTER TABLE sales ADD COLUMN corrects_sale_id TEXT;
ALTER TABLE sales ADD COLUMN correction_reason TEXT;
CREATE INDEX IF NOT EXISTS idx_sales_corrects ON sales(corrects_sale_id);` },
  // Corrections + synced conflicts + tamper protection. History can only grow: the database itself refuses deletes and edits
  // to the figures of a saved sale, stock event, audit entry, calculation or invoice (only sync bookkeeping columns may change).
  { version: 8, sql: `
ALTER TABLE sales ADD COLUMN corrects_sale_id TEXT;
ALTER TABLE sales ADD COLUMN correction_reason TEXT;
ALTER TABLE sync_conflicts ADD COLUMN device_id TEXT;
ALTER TABLE sync_conflicts ADD COLUMN sync_status TEXT DEFAULT 'SYNC_PENDING';
ALTER TABLE sync_conflicts ADD COLUMN updated_at TEXT;
ALTER TABLE sync_conflicts ADD COLUMN applied INTEGER DEFAULT 0;
UPDATE sync_conflicts SET updated_at=created_at;
CREATE INDEX IF NOT EXISTS idx_sync_conflicts_sync ON sync_conflicts(sync_status);
CREATE INDEX IF NOT EXISTS idx_sales_corrects ON sales(corrects_sale_id);
CREATE TRIGGER IF NOT EXISTS audit_logs_no_delete BEFORE DELETE ON audit_logs BEGIN SELECT RAISE(ABORT,'Records cannot be deleted'); END;
CREATE TRIGGER IF NOT EXISTS audit_logs_no_edit BEFORE UPDATE OF user_id,action,old_value,new_value,reason,created_at ON audit_logs BEGIN SELECT RAISE(ABORT,'Records cannot be changed'); END;
CREATE TRIGGER IF NOT EXISTS inventory_transactions_no_delete BEFORE DELETE ON inventory_transactions BEGIN SELECT RAISE(ABORT,'Records cannot be deleted'); END;
CREATE TRIGGER IF NOT EXISTS inventory_transactions_no_edit BEFORE UPDATE OF product_id,delta,reason,ref_id,created_at ON inventory_transactions BEGIN SELECT RAISE(ABORT,'Records cannot be changed'); END;
CREATE TRIGGER IF NOT EXISTS sale_items_no_delete BEFORE DELETE ON sale_items BEGIN SELECT RAISE(ABORT,'Records cannot be deleted'); END;
CREATE TRIGGER IF NOT EXISTS sale_items_no_edit BEFORE UPDATE OF sale_id,product_id,quantity,unit_price,subtotal,created_at ON sale_items BEGIN SELECT RAISE(ABORT,'Records cannot be changed'); END;
CREATE TRIGGER IF NOT EXISTS sales_no_delete BEFORE DELETE ON sales BEGIN SELECT RAISE(ABORT,'Records cannot be deleted'); END;
CREATE TRIGGER IF NOT EXISTS sales_no_edit BEFORE UPDATE OF total,receipt_no,user_id,created_at ON sales BEGIN SELECT RAISE(ABORT,'Records cannot be changed'); END;
CREATE TRIGGER IF NOT EXISTS calculations_no_delete BEFORE DELETE ON calculations BEGIN SELECT RAISE(ABORT,'Records cannot be deleted'); END;
CREATE TRIGGER IF NOT EXISTS calculations_no_edit BEFORE UPDATE OF expression,result,created_at ON calculations BEGIN SELECT RAISE(ABORT,'Records cannot be changed'); END;
CREATE TRIGGER IF NOT EXISTS invoices_no_delete BEFORE DELETE ON invoices BEGIN SELECT RAISE(ABORT,'Records cannot be deleted'); END;
CREATE TRIGGER IF NOT EXISTS invoice_items_no_delete BEFORE DELETE ON invoice_items BEGIN SELECT RAISE(ABORT,'Records cannot be deleted'); END;
` }
];
