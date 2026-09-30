import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { setAdapter, openDb, q, run } from '../src/db/db.js';
const mem = new DatabaseSync(':memory:');
setAdapter({ async open() {}, async exec(s) { mem.exec(s); }, async query(s, p = []) { return mem.prepare(s).all(...p); }, async run(s, p = []) { mem.prepare(s).run(...p); },
  async tx(st) { mem.exec('BEGIN'); try { for (const x of st) mem.prepare(x.statement).run(...x.values); mem.exec('COMMIT'); } catch (e) { mem.exec('ROLLBACK'); throw e; } } });
const auth = await import('../src/auth/auth.js');
const { addProduct } = await import('../src/domain/products.js');
const { saveTransaction } = await import('../src/domain/sales.js');
const { confirmSale } = await import('../src/domain/inventory.js');
const { correctSale, voidSale, getSaleDetail } = await import('../src/domain/corrections.js');
const { loadAudit, auditActions } = await import('../src/domain/audit.js');
const { dashboard } = await import('../src/domain/reports.js');
const stock = async (id) => (await q('SELECT quantity FROM products WHERE id=?', [id]))[0].quantity;
const ledger = async (id) => (await q('SELECT IFNULL(SUM(delta),0) s FROM inventory_transactions WHERE product_id=?', [id]))[0].s;
let coke, fanta, sale;
const line = (p, name, quantity, price = 500) => ({ productId: p.id, name, quantity, price, cost: 400 });
const sell = async (lines) => { const s = await saveTransaction(lines); await confirmSale(s.saleId); return s.saleId; };

test('setup', async () => {
  await openDb(); await auth.createAdmin({ fullName: 'Chris', username: 'chris', password: 'password123', businessName: 'Shop' });
  coke = await addProduct({ name: 'Coca Cola', sellPrice: '500', buyPrice: '400', quantity: '50' });
  fanta = await addProduct({ name: 'Fanta', sellPrice: '400', buyPrice: '300', quantity: '20' });
  sale = await sell([line(coke, 'Coca Cola', 5), line(fanta, 'Fanta', 2, 400)]);
  assert.equal(await stock(coke.id), 45);
});
test('a correction keeps the original, puts its stock back, and creates a linked replacement', async () => {
  const r = await correctSale(sale, { lines: [line(coke, 'Coca Cola', 3), line(fanta, 'Fanta', 2, 400)], reason: 'Incorrect quantity entered' });
  assert.equal(await stock(coke.id), 47); assert.equal(await stock(fanta.id), 18);
  for (const p of [coke, fanta]) assert.equal(await stock(p.id), await ledger(p.id));
  const orig = (await q('SELECT * FROM sales WHERE id=?', [sale]))[0];
  assert.equal(orig.status, 'corrected'); assert.equal(orig.total, 3300); assert.equal(orig.correction_reason, 'Incorrect quantity entered');
  assert.equal((await q('SELECT SUM(quantity) n FROM sale_items WHERE sale_id=? AND product_name=?', [sale, 'Coca Cola']))[0].n, 5);   // original lines untouched
  const d = await getSaleDetail(r.newSaleId);
  assert.equal(d.sale.status, 'confirmed'); assert.equal(d.sale.total, 2300); assert.equal(d.corrects.id, sale);
  assert.equal((await getSaleDetail(sale)).replacedBy[0].id, r.newSaleId);
  const a = (await getSaleDetail(sale)).trail.find(x => x.action === 'sale_corrected');
  assert.equal(a.reason, 'Incorrect quantity entered'); assert.match(a.old_value, /Coca Cola 5/); assert.match(a.new_value, /Coca Cola 3/);
  sale = r.newSaleId;
});
test('the dashboard counts the replacement once, never the original', async () => {
  const d = await dashboard('today');
  assert.equal(d.main.n, 1); assert.equal(d.main.revenue, 2300);
});
test('rules: reason required, only confirmed sales, not twice, stock must cover the new quantity', async () => {
  await assert.rejects(() => correctSale(sale, { lines: [line(coke, 'Coca Cola', 1)], reason: ' ' }), /reason/);
  await assert.rejects(() => correctSale(sale, { lines: [line(coke, 'Coca Cola', 0)], reason: 'typo' }), /quantity and price/);
  await assert.rejects(() => correctSale(sale, { lines: [line(coke, 'Coca Cola', 999)], reason: 'typo' }), /Only 50 units of Coca Cola/);
  assert.equal(await stock(coke.id), 47);                                        // refused: nothing changed
  const orig = (await q("SELECT id FROM sales WHERE corrects_sale_id IS NULL AND status='corrected'"))[0].id;
  await assert.rejects(() => correctSale(orig, { lines: [line(coke, 'Coca Cola', 1)], reason: 'again' }), /already corrected/);
  const s2 = await saveTransaction([line(coke, 'Coca Cola', 1)]);
  await assert.rejects(() => correctSale(s2.saleId, { lines: [], reason: 'not confirmed' }), /already calculated/);
});
test('voiding returns all the stock and leaves no replacement', async () => {
  const before = await stock(coke.id), id = await sell([line(coke, 'Coca Cola', 4)]);
  assert.equal(await stock(coke.id), before - 4);
  const r = await voidSale(id, 'Customer cancelled'); assert.equal(r.newSaleId, null);
  assert.equal(await stock(coke.id), before); assert.equal(await stock(coke.id), await ledger(coke.id));
  assert.equal((await q('SELECT status FROM sales WHERE id=?', [id]))[0].status, 'voided');
  assert.equal((await dashboard('today')).main.revenue, 2300);                      // voided sale not in the figures
});
test('a user the admin has restricted cannot correct, and an admin can view the audit log', async () => {
  await auth.addLinkedUser({ businessId: (await q('SELECT id FROM businesses'))[0].id, businessName: 'Shop', memberId: crypto.randomUUID(), fullName: 'Bob', username: 'bob', password: 'password123' });
  await run("UPDATE users SET permissions=? WHERE username='bob'", [JSON.stringify({ corrections: false })]);
  await auth.login('bob', 'password123');
  await assert.rejects(() => correctSale(sale, { lines: [], reason: 'nope' }), /Admin permission required/);
  await assert.rejects(() => loadAudit(), /Admin permission required/);
  await auth.login('chris', 'password123');
  assert.ok((await auditActions()).includes('sale_corrected'));
  const rows = await loadAudit({ action: 'sale_voided' }); assert.equal(rows.length, 1); assert.equal(rows[0].reason, 'Customer cancelled'); assert.equal(rows[0].who, 'Chris');
  assert.ok((await loadAudit({ text: 'customer cancelled' })).length >= 1);
  assert.equal((await loadAudit({ date: '2000-01-01' })).length, 0);
});
