import { q, uuid, now, tx, getSetting } from '../db/db.js';
import { currentUser } from '../auth/auth.js';
import { require_ } from '../auth/permissions.js';
import { ledgerStmts, auditStmt } from './inventory.js';
import { similarity } from '../ocr/parser.js';

const SYNC = `'SYNC_PENDING'`;

// Finds an existing product for a scanned name. >=0.9 links automatically; 0.6-0.9 is only a suggestion.
export async function matchProduct(name) {
  const n = name.trim().toLowerCase();
  if (!n) return { product: null, suggest: null };
  const tok = n.split(/\s+/).sort((a, b) => b.length - a.length)[0];
  const cands = await q(`SELECT id,name,sku,quantity FROM products WHERE active=1 AND (lower(name)=? OR lower(IFNULL(sku,''))=? OR lower(name) LIKE ?) LIMIT 50`, [n, n, `%${tok}%`]);
  let best = null, score = 0;
  for (const c of cands) { const s = c.sku && c.sku.toLowerCase() === n ? 1 : similarity(name, c.name); if (s > score) { best = c; score = s; } }
  return score >= 0.9 ? { product: best, suggest: null } : { product: null, suggest: score >= 0.6 ? best : null };
}

// draft: { header:{supplier,invoiceNo,date}, imageRef, ocrText, updateCost,
//          rows:[{name,quantity,unitPrice, match:{id,name,quantity}|null, create:boolean, sellPrice}] }
// Nothing touches inventory until this runs, and it is all-or-nothing.
export async function confirmInvoice(draft, { allowDuplicate = false } = {}) {
  const u = currentUser(); require_(u, 'scan_invoices');
  const rows = draft.rows.filter(r => r.match || r.create); // unresolved new products are skipped, never auto-created
  if (!rows.length) throw new Error('Nothing to add. Match a row to a product or tick Create this product.');
  for (const r of rows) {
    if (!(Number(r.quantity) > 0)) throw new Error(`Enter a quantity for ${r.name || 'every row'}.`);
    if (!(Number(r.unitPrice) >= 0) || r.unitPrice === '') throw new Error(`Enter a unit price for ${r.name}.`);
    if (!r.match && (r.sellPrice === '' || !(Number(r.sellPrice) >= 0))) throw new Error(`Enter a selling price for new product ${r.name}.`);
  }
  if (rows.some(r => !r.match)) require_(u, 'edit_products');
  const h = draft.header;
  if (!allowDuplicate && h.supplier && h.invoiceNo &&
    (await q(`SELECT 1 FROM invoices WHERE status='confirmed' AND lower(supplier)=? AND lower(invoice_no)=?`, [h.supplier.toLowerCase(), h.invoiceNo.toLowerCase()])).length)
    throw Object.assign(new Error('This invoice was already added.'), { code: 'DUPLICATE' });

  const dev = await getSetting('device_id'), t = now(), invId = uuid(), st = [];
  const lineTotal = (r) => Math.round(Number(r.quantity) * Number(r.unitPrice) * 100) / 100;
  const total = rows.reduce((a, r) => a + lineTotal(r), 0);
  st.push({ statement: `INSERT INTO invoices(id,supplier,invoice_no,invoice_date,image_ref,ocr_text,status,total,user_id,device_id,sync_status,created_at,updated_at) VALUES(?,?,?,?,?,?,'confirmed',?,?,?,${SYNC},?,?)`,
    values: [invId, h.supplier || null, h.invoiceNo || null, h.date || null, draft.imageRef || null, draft.ocrText || null, total, u.id, dev, t, t] });
  for (const r of rows) {
    const qty = Number(r.quantity), price = Number(r.unitPrice);
    let pid = r.match?.id;
    if (!pid) { // admin explicitly chose to create this product
      pid = uuid();
      st.push({ statement: `INSERT INTO products(id,name,quantity,buy_price,sell_price,supplier,device_id,sync_status,created_at,updated_at) VALUES(?,?,0,?,?,?,?,${SYNC},?,?)`,
        values: [pid, r.name.trim(), price, Number(r.sellPrice), h.supplier || null, dev, t, t] });
      st.push(auditStmt(u.id, 'product_created', null, { id: pid, name: r.name.trim(), via: 'invoice' }, null, dev, t));
    } else if (draft.updateCost) {
      st.push({ statement: `UPDATE products SET buy_price=?, sync_status=CASE WHEN sync_status='CONFLICT' THEN 'CONFLICT' ELSE 'SYNC_PENDING' END, updated_at=? WHERE id=?`, values: [price, t, pid] });
    }
    st.push({ statement: `INSERT INTO invoice_items(id,invoice_id,product_id,name,quantity,unit_price,total,is_new_product,device_id,sync_status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,${SYNC},?,?)`,
      values: [uuid(), invId, pid, r.name.trim(), qty, price, lineTotal(r), r.match ? 0 : 1, dev, t, t] });
    st.push(...ledgerStmts({ productId: pid, delta: qty, reason: 'invoice', refId: invId, note: h.invoiceNo ? `Invoice ${h.invoiceNo}` : 'Invoice', userId: u.id, dev, t }));
  }
  st.push(auditStmt(u.id, 'invoice_confirmed', null, { invoice: h.invoiceNo || null, supplier: h.supplier || null, items: rows.length, total }, null, dev, t));
  await tx(st);
  return { invoiceId: invId, items: rows.length, total };
}
