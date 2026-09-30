// 10,000 products, 30,000 confirmed sales (60,000 lines, 60,000 stock events) over 60 days.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { setAdapter, openDb, q } from '../src/db/db.js';
const mem = new DatabaseSync(':memory:');
setAdapter({ async open() {}, async exec(s) { mem.exec(s); }, async query(s, p = []) { return mem.prepare(s).all(...p); }, async run(s, p = []) { mem.prepare(s).run(...p); },
  async tx(st) { mem.exec('BEGIN'); try { for (const x of st) mem.prepare(x.statement).run(...x.values); mem.exec('COMMIT'); } catch (e) { mem.exec('ROLLBACK'); throw e; } } });
const auth = await import('../src/auth/auth.js');
const { searchProducts } = await import('../src/domain/products.js');
const { listProducts, lowStockCount } = await import('../src/domain/inventory.js');
const { loadHistory } = await import('../src/domain/sales.js');
const { dashboard } = await import('../src/domain/reports.js');
const { syncStatus } = await import('../src/sync/engine.js');
const times = {};
const time = async (name, fn) => { const t = performance.now(); const r = await fn(); times[name] = Math.round(performance.now() - t); return r; };

test('load 10,000 products and 30,000 sales', async () => {
  await openDb(); const u = await auth.createAdmin({ fullName: 'Chris', username: 'chris', password: 'password123' });
  const names = ['Cola', 'Fanta', 'Sprite', 'Malt', 'Water', 'Juice', 'Bread', 'Rice', 'Beans', 'Oil'];
  const T = new Date().toISOString(), ins = (sql) => mem.prepare(sql);
  mem.exec('BEGIN');
  const P = ins("INSERT INTO products(id,name,sku,barcode,quantity,buy_price,sell_price,low_stock_threshold,sync_status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,'SYNCED',?,?)");
  for (let i = 0; i < 10000; i++) P.run('p' + i, `${names[i % 10]} ${i}`, 'SKU' + i, String(600000000 + i), 50, 400, 500, i % 50 === 0 ? 60 : 5, T, T);
  const S = ins("INSERT INTO sales(id,receipt_no,user_id,status,total,sync_status,created_at,updated_at) VALUES(?,?,?,'confirmed',?,'SYNCED',?,?)");
  const I = ins("INSERT INTO sale_items(id,sale_id,product_id,product_name,quantity,unit_price,subtotal,unit_cost,sync_status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,'SYNCED',?,?)");
  const L = ins("INSERT INTO inventory_transactions(id,product_id,delta,reason,ref_id,sync_status,created_at,updated_at) VALUES(?,?,?,'sale',?,'SYNCED',?,?)");
  for (let i = 0; i < 30000; i++) {
    const at = new Date(Date.now() - (i % 60) * 864e5 - (i % 1440) * 60000).toISOString();
    S.run('s' + i, 'R' + i, u.id, 1000, at, at);
    for (let k = 0; k < 2; k++) { const pid = 'p' + ((i * 7 + k * 13) % 10000); I.run(`i${i}_${k}`, 's' + i, pid, 'Cola', 1, 500, 500, 400, at, at); L.run(`l${i}_${k}`, pid, -1, 's' + i, at, at); }
  }
  mem.exec('COMMIT');
  assert.equal((await q('SELECT COUNT(*) n FROM products'))[0].n, 10000);
});
test('the calculator search stays fast (offline, 10,000 products)', async () => {
  const r = await time('search "coc"', () => searchProducts('cola 99'));
  assert.ok(r.length > 0); assert.ok(times['search "coc"'] < 150, `${times['search "coc"']} ms`);
  await time('search by barcode', () => searchProducts('600005000'));
  assert.ok(times['search by barcode'] < 150);
});
test('inventory list, low-stock count and pending-upload count are paged and quick', async () => {
  assert.equal((await time('inventory page', () => listProducts({ limit: 30 }))).length, 30); assert.ok(times['inventory page'] < 150);
  assert.ok((await time('low-stock count', () => lowStockCount())) > 0); assert.ok(times['low-stock count'] < 150);
  await time('pending count', () => syncStatus()); assert.ok(times['pending count'] < 300);
});
test('history opens a day quickly, and the dashboard covers a month of sales', async () => {
  const h = await time('history (one day)', () => loadHistory({}));
  assert.ok(h.length <= 30 && times['history (one day)'] < 200);
  const d = await time('dashboard (month)', () => dashboard('month'));
  assert.ok(d.main.n > 0); assert.ok(times['dashboard (month)'] < 1500, `${times['dashboard (month)']} ms`);
});
test('the queries use indexes, not full scans, on the big tables', async () => {
  const plan = async (sql, p = []) => (await q('EXPLAIN QUERY PLAN ' + sql, p)).map(r => r.detail).join(' | ');
  assert.match(await plan("SELECT * FROM sale_items WHERE sale_id='s1'"), /idx_items_sale/);
  assert.match(await plan("SELECT * FROM sales WHERE created_at BETWEEN 'a' AND 'b'"), /idx_sales_created/);
  assert.match(await plan("SELECT * FROM inventory_transactions WHERE product_id='p1' ORDER BY created_at DESC LIMIT 15"), /idx_inv_product/);
  assert.match(await plan("SELECT * FROM products WHERE sync_status='SYNC_PENDING'"), /idx_products_sync/);
  assert.match(await plan("SELECT * FROM products WHERE barcode='1'"), /idx_p_barcode/);
});
test.after(() => console.log('TIMINGS (ms, Node on a server; phones are slower): ' + JSON.stringify(times)));
