// Runs the REAL migrations and domain code against in-memory SQLite (node:sqlite) instead of the phone's database.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { setAdapter, openDb, q } from '../src/db/db.js';

const mem = new DatabaseSync(':memory:');
setAdapter({
  async open() {}, async exec(sql) { mem.exec(sql); },
  async query(sql, p = []) { return mem.prepare(sql).all(...p); },
  async run(sql, p = []) { mem.prepare(sql).run(...p); },
  async tx(stmts) { mem.exec('BEGIN'); try { for (const s of stmts) mem.prepare(s.statement).run(...s.values); mem.exec('COMMIT'); } catch (e) { mem.exec('ROLLBACK'); throw e; } },
});
const { createAdmin, login, hasAdmin } = await import('../src/auth/auth.js');
const { addProduct, searchProducts } = await import('../src/domain/products.js');
const { saveTransaction, saveCalculation, loadHistory } = await import('../src/domain/sales.js');
const { confirmSale, adjustStock, lowStockCount, listProducts } = await import('../src/domain/inventory.js');
const { confirmInvoice } = await import('../src/domain/invoices.js');
const { dashboard } = await import('../src/domain/reports.js');
const stock = async (id) => (await q('SELECT quantity FROM products WHERE id=?', [id]))[0].quantity;
const ledger = async (id) => (await q('SELECT IFNULL(SUM(delta),0) s FROM inventory_transactions WHERE product_id=?', [id]))[0].s;
let coke, fanta;

test('migrations 1-8 apply cleanly', async () => {
  await openDb();
  const t = (await q("SELECT name FROM sqlite_master WHERE type='table'")).map(r => r.name);
  for (const n of ['users', 'products', 'sales', 'sale_items', 'calculations', 'inventory_transactions', 'invoices', 'invoice_items', 'audit_logs', 'notifications', 'sync_conflicts'])
    assert.ok(t.includes(n), n);
  assert.equal((await q('SELECT MAX(version) v FROM schema_version'))[0].v, 8);
});
test('admin registration and login', async () => {
  assert.equal(await hasAdmin(), false);
  await createAdmin({ fullName: 'Christopher', username: 'Chris', password: 'longenough1', businessName: 'Shop' });
  assert.equal(await hasAdmin(), true);
  await assert.rejects(() => login('chris', 'wrongpass1'), /Incorrect username or password/);
  const u = (await q('SELECT pw_hash FROM users'))[0];
  assert.ok(u.pw_hash && !u.pw_hash.includes('longenough1'));
});
test('product creation puts opening stock in the ledger', async () => {
  coke = await addProduct({ name: 'Coca Cola', sellPrice: '500', buyPrice: '400', quantity: '50', threshold: '5', category: 'Drinks', sku: 'CC1' });
  fanta = await addProduct({ name: 'Fanta', sellPrice: '400', quantity: '25', category: 'drinks' });
  assert.equal(await stock(coke.id), 50); assert.equal(await ledger(coke.id), 50);
  assert.equal((await q('SELECT COUNT(*) n FROM categories'))[0].n, 1); // "Drinks" and "drinks" are one category
  await assert.rejects(() => addProduct({ name: 'X', sellPrice: '1', sku: 'CC1' }), /SKU/);
});
test('search finds products by prefix, sku and category', async () => {
  assert.equal((await searchProducts('coc'))[0].name, 'Coca Cola');
  assert.equal((await searchProducts('cc1')).length, 1);
  assert.equal((await searchProducts('drinks')).length, 2);
  assert.equal((await searchProducts('zzz')).length, 0);
});
test('a calculation is saved but never touches stock', async () => {
  assert.equal(await saveCalculation('250+500×2'), 1250);
  assert.equal(await stock(coke.id), 50);
  assert.equal((await q('SELECT COUNT(*) n FROM calculations'))[0].n, 1);
});
test('multi-product sale: = saves, Confirm deducts, second confirm is refused', async () => {
  const s = await saveTransaction([{ productId: coke.id, name: 'Coca Cola', quantity: 3, price: 500, cost: 400 }, { productId: fanta.id, name: 'Fanta', quantity: 2, price: 400 }]);
  assert.equal(s.total, 2300); assert.match(s.receipt, /^STC-[0-9A-F]{4}-\d{6}$/);
  assert.equal(await stock(coke.id), 50);                       // saved, not yet a sale
  await confirmSale(s.saleId);
  assert.equal(await stock(coke.id), 47); assert.equal(await stock(fanta.id), 23);
  assert.equal(await stock(coke.id), await ledger(coke.id));    // cache equals ledger sum
  await assert.rejects(() => confirmSale(s.saleId), /already confirmed/);
  assert.equal(await stock(coke.id), 47);
  assert.equal((await q("SELECT COUNT(*) n FROM audit_logs WHERE action='sale_confirmed'"))[0].n, 1);
});
test('insufficient stock blocks the whole sale and changes nothing', async () => {
  const s = await saveTransaction([{ productId: fanta.id, name: 'Fanta', quantity: 1, price: 400 }, { productId: coke.id, name: 'Coca Cola', quantity: 60, price: 500 }]);
  await assert.rejects(() => confirmSale(s.saleId), /Only 47 units of Coca Cola available/);
  assert.equal(await stock(fanta.id), 23); assert.equal(await stock(coke.id), 47);
  assert.equal((await q('SELECT status FROM sales WHERE id=?', [s.saleId]))[0].status, 'calculated');
});
test('low-stock alert appears when a sale reaches the threshold', async () => {
  const s = await saveTransaction([{ productId: coke.id, name: 'Coca Cola', quantity: 42, price: 500, cost: 400 }]);
  const low = await confirmSale(s.saleId);
  assert.equal(await stock(coke.id), 5); assert.match(low[0], /Coca Cola/);
  assert.equal(await lowStockCount(), 1);
  assert.equal((await listProducts({ lowOnly: true })).length, 1);
  assert.equal((await q("SELECT COUNT(*) n FROM notifications WHERE type='low_stock'"))[0].n, 1);
});
test('removing stock below zero is refused unless negative stock is enabled', async () => {
  await assert.rejects(() => adjustStock({ productId: coke.id, delta: -6, reason: 'Damaged' }), /Only 5 units/);
  await adjustStock({ productId: coke.id, delta: 20, reason: 'Restock' });
  assert.equal(await stock(coke.id), 25); assert.equal(await stock(coke.id), await ledger(coke.id));
});
test('history lists sales and calculations, filtered by type', async () => {
  assert.ok((await loadHistory({ type: 'sale' })).every(r => r.kind === 'sale'));
  assert.equal((await loadHistory({ type: 'calc' })).length, 1);
  assert.ok((await loadHistory({ text: 'fanta' })).length >= 1);
});
test('dashboard counts only confirmed sales, with profit from saved cost', async () => {
  const d = await dashboard('today');
  assert.equal(d.main.n, 2); assert.equal(d.main.revenue, 2300 + 21000);
  assert.equal(d.profit.profit, 3 * 100 + 42 * 100 + 0);   // Fanta has no cost: left out, not guessed
  assert.equal(d.profit.missing, 1);
  assert.equal(d.top[0].name, 'Coca Cola'); assert.equal(d.top[0].qty, 45);
  assert.ok(d.trend.length >= 1);
});
test('invoice: adds to existing, never creates unticked products, blocks duplicates', async () => {
  const draft = { header: { supplier: 'ABC', invoiceNo: 'INV-1', date: '2026-09-29' }, updateCost: true, rows: [
    { name: 'Coca Cola', quantity: 20, unitPrice: 450, match: { id: coke.id }, create: false },
    { name: 'Sprite', quantity: 10, unitPrice: 300, match: null, create: false }] };
  const r = await confirmInvoice(draft);
  assert.equal(r.items, 1); assert.equal(await stock(coke.id), 45);
  assert.equal((await q("SELECT COUNT(*) n FROM products WHERE name='Sprite'"))[0].n, 0);
  assert.equal((await q('SELECT buy_price FROM products WHERE id=?', [coke.id]))[0].buy_price, 450);
  await assert.rejects(() => confirmInvoice(draft), /already added/);
  draft.rows[1].create = true; draft.rows[1].sellPrice = '350'; draft.header.invoiceNo = 'INV-2'; draft.rows[0].quantity = 0;
  await assert.rejects(() => confirmInvoice(draft), /quantity/);           // bad row: nothing is saved
  assert.equal((await q("SELECT COUNT(*) n FROM products WHERE name='Sprite'"))[0].n, 0);
  draft.rows[0].quantity = 5; await confirmInvoice(draft);
  assert.equal((await q("SELECT quantity FROM products WHERE name='Sprite'"))[0].quantity, 10);
});
test('the ledger always equals the cached quantity for every product', async () => {
  const rows = await q('SELECT p.name, p.quantity, IFNULL((SELECT SUM(delta) FROM inventory_transactions WHERE product_id=p.id),0) s FROM products p');
  for (const r of rows) assert.equal(r.quantity, r.s, r.name);
});
test('every saved row starts in the upload queue with this device id', async () => {
  const dev = (await q("SELECT value FROM settings WHERE key='device_id'"))[0].value;
  await saveCalculation('1+1'); const s = await saveTransaction([{ productId: coke.id, name: 'Coca Cola', quantity: 1, price: 500 }]);
  for (const [t, where] of [['calculations', "expression='1+1'"], ['sales', `id='${s.saleId}'`], ['sale_items', `sale_id='${s.saleId}'`]]) {
    const r = (await q(`SELECT sync_status, device_id FROM ${t} WHERE ${where}`))[0];
    assert.equal(r.sync_status, 'SYNC_PENDING', t); assert.equal(r.device_id, dev, t);
  }
});
test('history cannot be deleted or rewritten, even by the app itself', async () => {
  for (const sql of ['DELETE FROM audit_logs', 'DELETE FROM sales', 'DELETE FROM sale_items', 'DELETE FROM inventory_transactions', 'DELETE FROM calculations',
    "UPDATE sales SET total=1", "UPDATE inventory_transactions SET delta=999", "UPDATE audit_logs SET action='x'", "UPDATE sale_items SET quantity=99"])
    assert.throws(() => mem.exec(sql), /cannot be (deleted|changed)/, sql);
  mem.exec("UPDATE sales SET status='confirmed' WHERE status='confirmed'");   // status and sync bookkeeping may still change
});
