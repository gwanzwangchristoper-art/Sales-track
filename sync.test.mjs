// Two simulated phones (two separate SQLite databases) + a fake cloud that behaves like the SQL in 002_data_sync.sql.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { setAdapter, openDb, q, setSetting, uuid } from '../src/db/db.js';
import { setClientForTests } from '../src/cloud/client.js';
import { STATUS_RANK } from '../src/sync/merge.js';

// ---------- fake cloud ----------
const cloud = { down: false, tables: {}, clock: Date.parse('2026-09-29T08:00:00Z'), status: {}, deny: () => false, log: [] };
const tick = () => new Date((cloud.clock += 1)).toISOString();
const T = (n) => (cloud.tables[n] ||= []);
class Builder {
  constructor(t) { this.t = t; this.mode = 'select'; this.filters = []; this.orders = []; this.lim = 1e9; this.ret = false; this.one = false; }
  select() { this.ret = true; return this; }
  single() { this.one = true; return this; }
  gt(c, v) { this.filters.push(r => r[c] > v); return this; }
  eq(c, v) { this.filters.push(r => r[c] === v); return this; }
  order(c) { this.orders.push(c); return this; }
  limit(n) { this.lim = n; return this; }
  upsert(rows, o) { this.mode = 'upsert'; this.rows = rows; this.opt = o; return this; }
  insert(row) { this.mode = 'insert'; this.rows = [row]; return this; }
  update(p) { this.mode = 'update'; this.payload = p; return this; }
  then(res, rej) { return Promise.resolve(this.exec()).then(res, rej); }
  exec() {
    if (cloud.down) throw new Error('Failed to fetch');
    const rows = T(this.t), err = (code, message) => ({ data: null, error: { code, message } });
    if (['upsert', 'insert'].includes(this.mode)) {
      for (const r of this.rows) if (cloud.deny(this.t, r)) return err('42501', 'denied');
      for (const r of this.rows) {
        const ex = rows.find(x => x.id === r.id);
        if (ex && this.mode === 'insert') return err('23505', 'duplicate');
        if (ex && this.opt?.ignoreDuplicates) continue;
        cloud.log.push([this.t, r.id]);
        if (ex) { // ON CONFLICT DO UPDATE, with the triggers from the SQL file
          const keep = ex.status && (STATUS_RANK[r.status] || 0) < (STATUS_RANK[ex.status] || 0);
          if (this.t === 'sales') Object.assign(ex, r, { status: keep ? ex.status : r.status, total: ex.total, receipt_no: ex.receipt_no, created_at: ex.created_at });
          else if (this.t === 'sync_conflicts') Object.assign(ex, ex.status === 'resolved' ? { updated_at: r.updated_at } : r);
          else Object.assign(ex, r);
          ex.synced_at = tick();
        } else rows.push({ ...r, synced_at: tick(), ...(this.t === 'products' ? { version: 1 } : {}) });
      }
      const last = rows.find(x => x.id === this.rows[0].id);
      return { data: this.one ? last : null, error: null };
    }
    if (this.mode === 'update') {
      const hit = rows.filter(r => this.filters.every(f => f(r)));
      for (const r of hit) { Object.assign(r, this.payload); r.version += 1; r.synced_at = tick(); }
      return { data: hit.map(r => ({ version: r.version })), error: null };
    }
    let out = rows.filter(r => this.filters.every(f => f(r)));
    out.sort((a, b) => (a.synced_at < b.synced_at ? -1 : a.synced_at > b.synced_at ? 1 : a.id < b.id ? -1 : 1));
    return { data: out.slice(0, this.lim).map(r => ({ ...r })), error: null };
  }
}
setClientForTests({ from: (t) => new Builder(t), rpc: async (name, a) => cloud.down ? { data: null, error: { message: 'Failed to fetch' } } : ({ data: cloud.status[a.p_device_id] || 'active', error: null }) });
const { syncNow, syncStatus } = await import('../src/sync/engine.js');
const { resolveConflict } = await import('../src/sync/conflicts.js');

// ---------- two phones ----------
function phone(name) {
  const mem = new DatabaseSync(':memory:');
  return { name, adapter: {
    async open() {}, async exec(s) { mem.exec(s); }, async query(s, p = []) { return mem.prepare(s).all(...p); }, async run(s, p = []) { mem.prepare(s).run(...p); },
    async tx(st) { mem.exec('BEGIN'); try { for (const x of st) mem.prepare(x.statement).run(...x.values); mem.exec('COMMIT'); } catch (e) { mem.exec('ROLLBACK'); throw e; } } } };
}
const A = phone('A'), B = phone('B');
const sync = async () => { const r = await syncNow(); assert.equal(r.ok, true, 'sync failed: ' + r.error); };
const auth = await import('../src/auth/auth.js');
const { addProduct } = await import('../src/domain/products.js');
const { saveTransaction } = await import('../src/domain/sales.js');
const { confirmSale, updateProduct } = await import('../src/domain/inventory.js');
async function use(p, user) { setAdapter(p.adapter); await auth.login(user, 'password123'); }
const useA = () => use(A, 'chris'), useB = () => use(B, 'bob');
const stock = async (id) => (await q('SELECT quantity FROM products WHERE id=?', [id]))[0].quantity;
const sell = async (pid, name, qty) => { const s = await saveTransaction([{ productId: pid, name, quantity: qty, price: 500, cost: 400 }]); await confirmSale(s.saleId); return s.saleId; };
const edit = async (id, ch) => { const p = (await q('SELECT * FROM products WHERE id=?', [id]))[0];
  await updateProduct(id, { name: p.name, sellPrice: p.sell_price, buyPrice: p.buy_price ?? '', threshold: p.low_stock_threshold, sku: p.sku ?? '', barcode: '', supplier: '', description: '', ...ch }); };
let biz, coke;

test('setup: admin phone A and linked phone B share one business', async () => {
  setAdapter(A.adapter); await openDb();
  await auth.createAdmin({ fullName: 'Chris', username: 'chris', password: 'password123', businessName: 'Shop' });
  biz = (await q('SELECT id FROM businesses'))[0].id; await setSetting('cloud_enabled', 'true');
  setAdapter(B.adapter); await openDb();
  await auth.addLinkedUser({ businessId: biz, businessName: 'Shop', memberId: uuid(), fullName: 'Bob', username: 'bob', password: 'password123' });
  await setSetting('cloud_enabled', 'true');
  await useA(); coke = await addProduct({ name: 'Coca Cola', sellPrice: '500', buyPrice: '400', quantity: '50', threshold: '5' });
  await sync();
  await useB(); await sync();
  assert.equal(await stock(coke.id), 50);                          // B rebuilt stock from the ledger
});
test('offline sales on two phones merge: -10 and -7 make -17, nothing lost or duplicated', async () => {
  await useA(); for (let i = 0; i < 3; i++) await sell(coke.id, 'Coca Cola', i === 0 ? 4 : 3);   // 3 sales = 10 units, offline
  await useB(); await sell(coke.id, 'Coca Cola', 4); await sell(coke.id, 'Coca Cola', 3);         // 2 sales = 7 units, offline
  assert.equal(await stock(coke.id), 43);
  await sync(); await useA(); await sync(); await useB(); await sync(); await useA(); await sync();
  assert.equal(await stock(coke.id), 33);
  await useB(); assert.equal(await stock(coke.id), 33);
  assert.equal((await q("SELECT COUNT(*) n FROM sales WHERE status='confirmed'"))[0].n, 5);          // all five sales on both phones
  await useA(); assert.equal((await q("SELECT COUNT(*) n FROM sales WHERE status='confirmed'"))[0].n, 5);
  assert.equal(T('inventory_transactions').filter(r => r.reason === 'sale').length, 5);
  const before = cloud.log.length, ledgerRows = T('inventory_transactions').length; await sync(); await useB(); await sync();
  assert.deepEqual(cloud.log.slice(before).filter(([t]) => t !== 'audit_logs'), []);                 // no sale or product uploaded twice (new login audit rows are expected)
  assert.equal(T('inventory_transactions').length, ledgerRows);
  assert.equal(new Set(T('sales').map(r => r.id)).size, T('sales').length);                          // unique ids in the cloud
  assert.equal((await syncStatus()).pending, 0);
});
test('both phones confirm the SAME sale offline: stock drops once', async () => {
  await useA(); const s = await saveTransaction([{ productId: coke.id, name: 'Coca Cola', quantity: 3, price: 500 }]); await sync();
  await useB(); await sync();
  await confirmSale(s.saleId); await useA(); await confirmSale(s.saleId);
  await sync(); await useB(); await sync(); await useA(); await sync();
  assert.equal(await stock(coke.id), 30); await useB(); assert.equal(await stock(coke.id), 30);
  assert.equal(T('inventory_transactions').filter(r => r.ref_id === s.saleId).length, 1);
});
test('edits to different product fields on two phones both survive', async () => {
  await useA(); await edit(coke.id, { sellPrice: '550' });
  await useB(); await edit(coke.id, { threshold: '9' });
  await sync(); await useA(); await sync(); await useB(); await sync(); await useA(); await sync();
  for (const use_ of [useA, useB]) { await use_(); const p = (await q('SELECT * FROM products WHERE id=?', [coke.id]))[0];
    assert.equal(p.sell_price, 550); assert.equal(p.low_stock_threshold, 9); assert.equal(p.sync_status, 'SYNCED'); }
  assert.equal((await q("SELECT COUNT(*) n FROM sync_conflicts WHERE status='open'"))[0].n, 0);
});
test('the SAME field edited differently is a conflict: nothing overwritten until the admin decides', async () => {
  await useA(); await edit(coke.id, { sellPrice: '600' });
  await useB(); await edit(coke.id, { sellPrice: '650' });
  await useA(); await sync(); await useB(); await sync();                     // B meets A's change
  let p = (await q('SELECT * FROM products WHERE id=?', [coke.id]))[0];
  assert.equal(p.sell_price, 650); assert.equal(p.sync_status, 'CONFLICT');          // B's own edit is kept, flagged
  assert.equal(T('products').find(r => r.id === coke.id).sell_price, 600);            // cloud untouched by B
  const c = (await q("SELECT * FROM sync_conflicts WHERE kind='field' AND status='open'"))[0];
  assert.equal(c.field, 'sell_price');
  await assert.rejects(() => resolveConflict(c.id, 'theirs'), /Admin permission/);  // Bob is not the admin
  await useA(); await sync();
  assert.equal((await q('SELECT sell_price FROM products WHERE id=?', [coke.id]))[0].sell_price, 600);
});
test('the admin resolves a conflict raised on Bob\'s phone, and Bob\'s phone applies the decision', async () => {
  await useB(); await sync();                                                       // Bob's phone uploads the conflict record
  await useA(); await sync();
  const c = (await q("SELECT * FROM sync_conflicts WHERE kind='field' AND status='open'"))[0];
  assert.ok(c, 'admin phone sees the conflict'); assert.equal(c.field, 'sell_price');
  assert.equal((await q("SELECT COUNT(*) n FROM notifications WHERE type='sync_conflict'"))[0].n >= 1, true);
  await resolveConflict(c.id, 'local');                                            // keep Bob's 650
  await sync(); await useB(); await sync(); await sync();
  const p = (await q('SELECT sell_price, sync_status FROM products WHERE id=?', [coke.id]))[0];
  assert.equal(p.sell_price, 650); assert.equal(p.sync_status, 'SYNCED');
  assert.equal((await q("SELECT COUNT(*) n FROM sync_conflicts WHERE status='open'"))[0].n, 0);
  await useA(); await sync(); assert.equal((await q('SELECT sell_price FROM products WHERE id=?', [coke.id]))[0].sell_price, 650);
});
test('stock that goes negative after combining phones raises a conflict but keeps every sale', async () => {
  await useA(); await sync(); await useB(); await sync();
  await useA(); await sell(coke.id, 'Coca Cola', 20); await useB(); await sell(coke.id, 'Coca Cola', 20);  // stock 30: each phone sees enough
  await sync(); await useA(); await sync(); await useB(); await sync();
  assert.equal(await stock(coke.id), -10);
  const c = (await q("SELECT * FROM sync_conflicts WHERE kind='negative_stock'"))[0];
  assert.equal(c.status, 'open'); assert.ok(JSON.parse(c.detail).length >= 2);
  assert.equal((await q("SELECT COUNT(*) n FROM notifications WHERE type='sync_conflict'"))[0].n >= 1, true);
});
test('a refused row is set aside; the rest of the batch still uploads', async () => {
  await useA(); const ok = await sell(coke.id, 'Coca Cola', 0.5).catch(() => null);
  cloud.deny = (t, r) => t === 'calculations';
  const { saveCalculation } = await import('../src/domain/sales.js');
  await saveCalculation('2+2'); await addProduct({ name: 'Fanta', sellPrice: '400', quantity: '5' });
  await sync();
  assert.equal((await q("SELECT COUNT(*) n FROM calculations WHERE sync_status='REJECTED'"))[0].n, 1);
  assert.ok(T('products').some(r => r.name === 'Fanta'));                            // unaffected rows went through
  cloud.deny = () => false;
});
test('the same sale corrected on two phones: stock is put back once, the extra replacement is flagged and voided', async () => {
  const { correctSale, voidSale } = await import('../src/domain/corrections.js');
  await useA(); const sp = await addProduct({ name: 'Sprite', sellPrice: '300', buyPrice: '200', quantity: '100' });
  await sync(); await useB(); await sync();
  const sid = await sell(sp.id, 'Sprite', 3); await sync(); await useA(); await sync();     // 97 everywhere
  assert.equal(await stock(sp.id), 97);
  await useA(); await correctSale(sid, { lines: [{ productId: sp.id, name: 'Sprite', quantity: 2, price: 300 }], reason: 'Customer took 2' });
  await useB(); await correctSale(sid, { lines: [{ productId: sp.id, name: 'Sprite', quantity: 1, price: 300 }], reason: 'Customer took 1' });
  for (let i = 0; i < 2; i++) { await sync(); await useA(); await sync(); await useB(); }
  await sync(); await useA(); await sync();
  assert.equal(T('inventory_transactions').filter(r => r.reason === 'reversal' && r.ref_id === sid).length, 1);   // reversed once
  assert.equal(await stock(sp.id), 100 - 2 - 1);                                                                     // both replacements applied
  const c = (await q("SELECT * FROM sync_conflicts WHERE kind='duplicate_correction' AND status='open'"))[0];
  assert.ok(c);
  const [x, y] = JSON.parse(c.detail).sales; const one = (await q('SELECT s.id FROM sales s JOIN sale_items i ON i.sale_id=s.id WHERE s.id IN (?,?) AND i.quantity=1', [x, y]))[0].id;
  await voidSale(one, 'Duplicate correction'); await resolveConflict(c.id, 'acknowledge');
  await sync(); await useB(); await sync(); await useA(); await sync();
  assert.equal(await stock(sp.id), 98); await useB(); assert.equal(await stock(sp.id), 98);
  assert.equal((await q("SELECT status FROM sales WHERE id=?", [sid]))[0].status, 'corrected');
  assert.equal((await q("SELECT COUNT(*) n FROM sync_conflicts WHERE kind='duplicate_correction' AND status='open'"))[0].n, 0);   // (the earlier negative-stock item is still open on purpose)
});
test('failed sync: no internet keeps everything, and the next run uploads it once', async () => {
  await useA(); await sell(coke.id, 'Coca Cola', 0.25).catch(() => {}); const before = (await syncStatus()).pending; assert.ok(before > 0);
  cloud.down = true; const r = await syncNow();
  assert.ok(r.error); assert.equal((await syncStatus()).pending, before);                       // nothing lost, still queued
  assert.match((await syncStatus()).error, /Sync failed|Offline/);
  cloud.down = false; await sync(); assert.equal((await syncStatus()).pending, 0); assert.equal((await syncStatus()).error, '');
});
test('lost phone: a brand-new phone linked to the business rebuilds stock, sales and history from the cloud', async () => {
  await useA(); await sync();
  const want = { coke: await stock(coke.id), sales: (await q('SELECT COUNT(*) n FROM sales'))[0].n, items: (await q('SELECT COUNT(*) n FROM sale_items'))[0].n, products: (await q('SELECT COUNT(*) n FROM products'))[0].n };
  const C = phone('C'); setAdapter(C.adapter); await openDb();
  await auth.addLinkedUser({ businessId: biz, businessName: 'Shop', memberId: uuid(), fullName: 'Carol', username: 'carol', password: 'password123' });
  await setSetting('cloud_enabled', 'true'); await sync();
  assert.equal(await stock(coke.id), want.coke);
  assert.equal((await q('SELECT COUNT(*) n FROM sales'))[0].n, want.sales); assert.equal((await q('SELECT COUNT(*) n FROM sale_items'))[0].n, want.items);
  assert.equal((await q('SELECT COUNT(*) n FROM products'))[0].n, want.products);
  const bad = await q('SELECT p.name, p.quantity, IFNULL((SELECT SUM(delta) FROM inventory_transactions WHERE product_id=p.id),0) s FROM products p'); // stock == ledger for every product
  for (const r of bad) assert.equal(r.quantity, r.s, r.name);
});
test('a revoked phone stops syncing but keeps its data', async () => {
  await useB(); const devB = (await q("SELECT value FROM settings WHERE key='device_id'"))[0].value;
  await sell(coke.id, 'Coca Cola', 0.5).catch(() => {}); const pending = (await syncStatus()).pending;
  cloud.status[devB] = 'revoked';
  const r = await syncNow(); assert.equal(r.revoked, true);
  assert.equal((await syncStatus()).pending, pending);
  await assert.rejects(() => auth.login('bob', 'password123'), /removed by the admin/);
});
