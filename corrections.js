// A correction NEVER edits a sale. The original stays exactly as it was (status becomes 'corrected' or 'voided'),
// a reversal puts its stock back, and a new linked sale carries the right figures. Everything is one atomic write.
import { q, uuid, now, tx, getSetting, setSetting } from '../db/db.js';
import { currentUser } from '../auth/auth.js';
import { require_ } from '../auth/permissions.js';
import { ledgerStmts, auditStmt, lowStockCheck } from './inventory.js';
import { detId } from '../sync/ids.js';
import { nextReceipt, commitReceipt } from './receipt.js';

const SYNC = `'SYNC_PENDING'`, r2 = (n) => Math.round(n * 100) / 100;
const qtyBy = (rows, key) => rows.reduce((m, r) => (r[key] ? { ...m, [r[key]]: (m[r[key]] || 0) + Number(r.quantity) } : m), {});
const describe = (rows, name, price) => rows.map(r => `${r[name]} ${r.quantity}×${r[price]}`);

// lines = the corrected sale [{productId,name,quantity,price,cost}]. No lines = void the whole sale.
export async function correctSale(saleId, { lines = [], reason } = {}) {
  const u = currentUser(); require_(u, 'corrections');
  const why = (reason || '').trim();
  if (why.length < 3) throw new Error('Enter the reason for this correction.');
  const sale = (await q('SELECT * FROM sales WHERE id=?', [saleId]))[0];
  if (!sale) throw new Error('Sale not found.');
  if (sale.status !== 'confirmed') throw new Error(`This sale is already ${sale.status}.`);
  if (lines.length) require_(u, 'sell');
  if (lines.some(l => !(Number(l.quantity) > 0) || !(Number(l.price) >= 0))) throw new Error('Enter a quantity and price for every line, or void the sale.');

  const old = await q('SELECT * FROM sale_items WHERE sale_id=?', [saleId]);
  const oldQ = qtyBy(old, 'product_id'), newQ = qtyBy(lines, 'productId'), neg = (await getSetting('negative_stock')) === 'true';
  for (const [pid, want] of Object.entries(newQ)) { // after the reversal, is there enough for the corrected quantity?
    const p = (await q('SELECT name,quantity FROM products WHERE id=?', [pid]))[0];
    if (!p) throw new Error('A product in this sale no longer exists.');
    const avail = p.quantity + (oldQ[pid] || 0);
    if (!neg && avail < want) throw new Error(avail > 0 ? `Only ${avail} units of ${p.name} available.` : `${p.name} is out of stock.`);
  }

  const dev = await getSetting('device_id'), t = now(), st = [];
  for (const [pid, qty] of Object.entries(oldQ)) // deterministic id: if two phones correct the same sale, the reversal happens once
    st.push(...ledgerStmts({ id: await detId(`reversal:${saleId}:${pid}`), productId: pid, delta: qty, reason: 'reversal', refId: saleId, note: `Correction: ${why}`, userId: u.id, dev, t }));
  st.push({ statement: `UPDATE sales SET status=?, correction_reason=?, sync_status=${SYNC}, updated_at=? WHERE id=?`, values: [lines.length ? 'corrected' : 'voided', why, t, saleId] });

  let newId = null, receipt = null, n = 0, total = 0;
  if (lines.length) {
    newId = uuid(); ({ n, no: receipt } = await nextReceipt());
    total = r2(lines.reduce((a, l) => a + Number(l.quantity) * Number(l.price), 0));
    st.push({ statement: `INSERT INTO sales(id,receipt_no,user_id,status,total,corrects_sale_id,correction_reason,device_id,sync_status,created_at,updated_at) VALUES(?,?,?,'confirmed',?,?,?,?,${SYNC},?,?)`,
      values: [newId, receipt, u.id, total, saleId, why, dev, t, t] });
    for (const l of lines)
      st.push({ statement: `INSERT INTO sale_items(id,sale_id,product_id,product_name,quantity,unit_price,subtotal,unit_cost,device_id,sync_status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,${SYNC},?,?)`,
        values: [uuid(), newId, l.productId, l.name, Number(l.quantity), Number(l.price), r2(l.quantity * l.price), l.cost ?? null, dev, t, t] });
    for (const [pid, qty] of Object.entries(newQ)) st.push(...ledgerStmts({ productId: pid, delta: -qty, reason: 'sale', refId: newId, userId: u.id, dev, t }));
  }
  st.push(auditStmt(u.id, lines.length ? 'sale_corrected' : 'sale_voided',
    { sale: saleId, receipt: sale.receipt_no, total: sale.total, items: describe(old, 'product_name', 'unit_price') },
    lines.length ? { sale: newId, receipt, total, items: describe(lines, 'name', 'price') } : { sale: saleId, status: 'voided' }, why, dev, t));
  await tx(st);
  if (lines.length) await commitReceipt(n);
  return { newSaleId: newId, receipt, low: await lowStockCheck(Object.keys(newQ)) };
}
export const voidSale = (saleId, reason) => correctSale(saleId, { lines: [], reason });

export async function getSaleDetail(id) {
  const sale = (await q('SELECT s.*, u.full_name who FROM sales s LEFT JOIN users u ON u.id=s.user_id WHERE s.id=?', [id]))[0];
  if (!sale) throw new Error('Sale not found.');
  return {
    sale, items: await q('SELECT * FROM sale_items WHERE sale_id=?', [id]),
    corrects: sale.corrects_sale_id ? (await q('SELECT id,receipt_no FROM sales WHERE id=?', [sale.corrects_sale_id]))[0] : null,
    replacedBy: await q('SELECT id,receipt_no,status FROM sales WHERE corrects_sale_id=?', [id]),
    trail: await q(`SELECT a.*, u.full_name who FROM audit_logs a LEFT JOIN users u ON u.id=a.user_id
      WHERE a.new_value LIKE ? OR a.old_value LIKE ? OR a.new_value LIKE ? OR a.old_value LIKE ? ORDER BY a.created_at`,
      [`%${id}%`, `%${id}%`, `%${sale.receipt_no}%`, `%${sale.receipt_no}%`]),
  };
}
