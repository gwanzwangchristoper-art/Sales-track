import { q, uuid, now, tx, getSetting, setSetting } from '../db/db.js';
import { currentUser } from '../auth/auth.js';
import { require_ } from '../auth/permissions.js';
import { evaluate } from './calculator.js';

const cols = 'device_id,sync_status,created_at,updated_at'; // VALUES must read: device, 'SYNC_PENDING', time, time

// Ordinary maths: saved to history, NEVER touches inventory.
export async function saveCalculation(expression) {
  const u = currentUser(); require_(u, 'calculate');
  const result = evaluate(expression), t = now(), dev = await getSetting('device_id');
  await tx([{ statement: `INSERT INTO calculations(id,user_id,expression,result,${cols}) VALUES(?,?,?,?,?,'SYNC_PENDING',?,?)`,
    values: [uuid(), u.id, expression, result, dev, t, t] }]);
  return result;
}

// Pressing "=" on a product transaction saves it as 'calculated'. Stock is unchanged until the sale
// is confirmed (Phase 3), so nothing is deducted by accident.
export async function saveTransaction(lines) {
  const u = currentUser(); require_(u, 'sell');
  const items = lines.filter(l => l.quantity > 0);
  if (!items.length) throw new Error('Add at least one product.');
  const total = Math.round(items.reduce((a, l) => a + l.quantity * l.price, 0) * 100) / 100;
  const n = Number((await getSetting('receipt_counter')) || 0) + 1;
  const saleId = uuid(), t = now(), dev = await getSetting('device_id'), receipt = 'STC-' + String(n).padStart(6, '0');
  await tx([
    { statement: `INSERT INTO sales(id,receipt_no,user_id,status,total,${cols}) VALUES(?,?,?,?,?,?,'SYNC_PENDING',?,?)`,
      values: [saleId, receipt, u.id, 'calculated', total, dev, t, t] },
    ...items.map(l => ({ statement: `INSERT INTO sale_items(id,sale_id,product_id,product_name,quantity,unit_price,subtotal,unit_cost,${cols}) VALUES(?,?,?,?,?,?,?,?,?,'SYNC_PENDING',?,?)`,
      values: [uuid(), saleId, l.productId, l.name, l.quantity, l.price, Math.round(l.quantity * l.price * 100) / 100, l.cost ?? null, dev, t, t] })),
  ]);
  await setSetting('receipt_counter', n);
  return { saleId, receipt, total };
}

// History: calculations and transactions merged newest-first, paginated.
export async function loadHistory({ date, type = 'all', text = '', offset = 0, limit = 30 }) {
  const day = date || new Date().toLocaleDateString('en-CA');
  const start = new Date(day + 'T00:00:00').toISOString(), end = new Date(day + 'T23:59:59.999').toISOString();
  const like = `%${text.toLowerCase()}%`;
  const parts = [];
  if (type !== 'calc') parts.push(`SELECT s.id, 'sale' kind, s.created_at, s.total value, s.receipt_no ref, s.status, s.corrects_sale_id corr,
      (SELECT group_concat(product_name||' × '||quantity, ', ') FROM sale_items WHERE sale_id=s.id) summary, u.full_name who
      FROM sales s LEFT JOIN users u ON u.id=s.user_id WHERE s.created_at BETWEEN ? AND ?`);
  if (type !== 'sale') parts.push(`SELECT c.id, 'calc' kind, c.created_at, c.result value, NULL ref, 'calculation' status, NULL corr,
      c.expression summary, u.full_name who FROM calculations c LEFT JOIN users u ON u.id=c.user_id WHERE c.created_at BETWEEN ? AND ?`);
  const args = parts.flatMap(() => [start, end]);
  const rows = await q(`SELECT * FROM (${parts.join(' UNION ALL ')}) WHERE lower(summary) LIKE ? OR lower(IFNULL(ref,'')) LIKE ?
    ORDER BY created_at DESC LIMIT ? OFFSET ?`, [...args, like, like, limit, offset]);
  return rows;
}
