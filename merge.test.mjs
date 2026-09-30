import test from 'node:test';
import assert from 'node:assert/strict';
import { threeWayMerge, mergeStatus, planProductPull, toCloudRow, fromCloudRow, isoTs, TABLES, META } from '../src/sync/merge.js';
import { detId } from '../src/sync/ids.js';

const base = { name: 'Coca Cola', sell_price: 500, low_stock_threshold: 5, buy_price: 400 };

test('edits to DIFFERENT fields on two devices merge with no conflict', () => {
  const r = threeWayMerge(base, { ...base, sell_price: 550 }, { ...base, low_stock_threshold: 8 }, Object.keys(base));
  assert.deepEqual(r.conflicts, []);
  assert.equal(r.merged.sell_price, 550); assert.equal(r.merged.low_stock_threshold, 8);
});
test('the SAME field changed to different values is a conflict and nothing is overwritten', () => {
  const r = threeWayMerge(base, { ...base, sell_price: 550 }, { ...base, sell_price: 600 }, Object.keys(base));
  assert.deepEqual(r.conflicts, [{ field: 'sell_price', local: 550, remote: 600 }]);
  assert.equal(r.merged.sell_price, 550);
});
test('both devices making the same change is not a conflict', () => {
  assert.deepEqual(threeWayMerge(base, { ...base, sell_price: 600 }, { ...base, sell_price: 600 }, Object.keys(base)).conflicts, []);
});
test('with no known history, any difference is flagged rather than guessed', () => {
  assert.equal(threeWayMerge(null, { name: 'A' }, { name: 'B' }, ['name']).conflicts.length, 1);
  assert.equal(threeWayMerge(null, { name: 'A' }, { name: 'A' }, ['name']).conflicts.length, 0);
});
test('undefined and null count as the same empty value', () => {
  assert.deepEqual(threeWayMerge({ sku: null }, { sku: undefined }, { sku: null }, ['sku']).conflicts, []);
});
test('sale status only moves forward', () => {
  assert.equal(mergeStatus('calculated', 'confirmed'), 'confirmed');
  assert.equal(mergeStatus('confirmed', 'calculated'), 'confirmed');
  assert.equal(mergeStatus('confirmed', 'corrected'), 'corrected');
  assert.equal(mergeStatus('corrected', 'confirmed'), 'corrected');
});

const meta = (o = {}) => ({ ...Object.fromEntries(META.map(k => [k, null])), name: 'Fanta', sell_price: 400, active: 1, ...o });
test('product pull: new, already-have, clean take, merge and conflict', () => {
  const remote = { ...meta(), id: 'p', version: 3 };
  assert.equal(planProductPull(undefined, remote).action, 'insert');
  assert.equal(planProductPull({ ...meta(), base_version: 3, sync_status: 'SYNCED' }, remote).action, 'skip');
  assert.equal(planProductPull({ ...meta(), base_version: 2, sync_status: 'SYNCED' }, remote).action, 'take');
  const baseJson = JSON.stringify(meta());
  const mine = { ...meta({ sell_price: 450 }), base_version: 2, base_json: baseJson, sync_status: 'SYNC_PENDING' };
  assert.equal(planProductPull(mine, { ...remote, ...meta({ supplier: 'X' }) }).action, 'merge');
  const c = planProductPull(mine, { ...remote, ...meta({ sell_price: 500 }) });
  assert.equal(c.action, 'conflict'); assert.equal(c.conflicts[0].field, 'sell_price'); assert.equal(c.meta.sell_price, 450);
});
test('stock events add up: -10 on A and -7 on B is -17 whatever order they arrive', () => {
  const apply = (start, events) => events.reduce((q, e) => q + e.delta, start);
  const A = [{ id: 'a1', delta: -10 }], B = [{ id: 'b1', delta: -7 }];
  const merge = (...lists) => [...new Map(lists.flat().map(e => [e.id, e])).values()]; // ids dedupe, like the ledger
  assert.equal(apply(50, merge(A, B)), 33); assert.equal(apply(50, merge(B, A)), 33);
  assert.equal(apply(50, merge(A, B, A, B)), 33); // re-delivery changes nothing
});
test('two devices confirming the same sale produce the same ledger id, so stock drops once', async () => {
  assert.equal(await detId('sale:S1:P1'), await detId('sale:S1:P1'));
  assert.notEqual(await detId('sale:S1:P1'), await detId('sale:S1:P2'));
  assert.match(await detId('x'), /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});
test('cloud rows: business added, timestamps normalised, quantity never uploaded', () => {
  const T = TABLES.find(t => t.name === 'products');
  const row = toCloudRow(T, { id: 'p', device_id: 'd', created_at: 't', updated_at: 't', name: 'A', quantity: 99, sell_price: 1 }, 'B1');
  assert.equal(row.business_id, 'B1'); assert.equal('quantity' in row, false); assert.equal('sync_status' in row, false);
  assert.equal(isoTs('2026-09-29T10:00:00+00:00'), '2026-09-29T10:00:00.000Z');
  const back = fromCloudRow({ id: 'x', business_id: 'B', synced_at: 's', created_at: '2026-09-29T10:00:00+00:00', updated_at: '2026-09-29T10:00:00+00:00' });
  assert.equal(back.created_at, '2026-09-29T10:00:00.000Z'); assert.equal('business_id' in back, false);
});
test('every synced table pushes parents before children', () => {
  const order = TABLES.map(t => t.name);
  assert.ok(order.indexOf('products') < order.indexOf('inventory_transactions'));
  assert.ok(order.indexOf('sales') < order.indexOf('sale_items'));
  assert.ok(order.indexOf('invoices') < order.indexOf('invoice_items'));
});
