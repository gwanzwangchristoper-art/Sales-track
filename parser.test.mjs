import test from 'node:test';
import assert from 'node:assert/strict';
import { parseInvoice, groupRows, similarity } from '../src/ocr/parser.js';

const sample = ['ABC Beverages Ltd', 'Invoice No: INV-0042', 'Date: 12/03/2025', 'S/N Item Qty Price Amount',
  '1 Coca Cola 20 450 9000', '2 Fanta 10 500 5,000', '7 Up 12 300 3600', 'Sub Total 17,600', 'Total ₦17,600'];

test('reads header', () => {
  const r = parseInvoice(sample);
  assert.equal(r.header.supplier, 'ABC Beverages Ltd');
  assert.equal(r.header.invoiceNo, 'INV-0042');
  assert.equal(r.header.date, '2025-03-12');
  assert.equal(r.statedTotal, 17600);
});
test('reads item rows, keeps "7 Up", strips line numbers', () => {
  const it = parseInvoice(sample).items;
  assert.deepEqual(it.map(i => i.name), ['Coca Cola', 'Fanta', '7 Up']);
  assert.deepEqual(it.map(i => [i.quantity, i.unitPrice, i.total]), [[20, 450, 9000], [10, 500, 5000], [12, 300, 3600]]);
  assert.ok(it.every(i => i.confidence === 'high'));
});
test('flags rows whose numbers do not multiply', () => {
  const it = parseInvoice(['Pepsi 10 450 5000']).items;
  assert.equal(it[0].confidence, 'low');
});
test('two-number rows are low confidence', () => {
  assert.equal(parseInvoice(['Milk 5 2500']).items[0].confidence, 'low');
});
test('ignores totals, phone and address lines', () => {
  assert.equal(parseInvoice(['Tel 0803 123 4567', 'VAT 7.5% 500', 'Total 9000']).items.length, 0);
});
test('groups OCR boxes into rows left-to-right', () => {
  const d = (t, x, y) => ({ text: t, topLeft: [x, y], bottomLeft: [x, y + 10] });
  assert.deepEqual(groupRows([d('450', 200, 52), d('Fanta', 10, 50), d('Coca', 10, 20), d('Cola', 60, 21), d('500', 200, 22)]),
    ['Coca Cola 500', 'Fanta 450']);
});
test('similarity: identical, close, different', () => {
  assert.equal(similarity('Coca Cola', 'coca-cola'), 1);
  assert.ok(similarity('Coca Cola 50cl', 'Coca Cola') > 0.7);
  assert.ok(similarity('Fanta', 'Pepsi') < 0.3);
});
