import { captureInvoice, recognize } from '../ocr/ocr.js';
import { parseInvoice } from '../ocr/parser.js';
import { matchProduct, confirmInvoice } from '../domain/invoices.js';
import { money } from '../domain/calculator.js';
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
let host, done, draft, statedTotal;

export function scanInvoice(h, onDone) {
  host = h; done = onDone;
  host.innerHTML = `<h2>Scan invoice</h2><p class="sub">Photograph the supplier's invoice. You'll review everything before stock changes.</p>
  <div class="err" id="err"></div><button class="btn" id="cam">Take photo</button><button class="btn alt" id="man">Enter manually</button><button class="btn alt" id="bk">Back</button>`;
  $('bk').onclick = done; $('man').onclick = () => review({ header: { supplier: '', invoiceNo: '', date: '' }, items: [{ name: '', quantity: '', unitPrice: '', confidence: 'high' }] });
  $('cam').onclick = async () => {
    $('err').textContent = ''; $('cam').disabled = true; $('cam').textContent = 'Reading invoice…';
    try {
      const { imageRef, path } = await captureInvoice(), { rows, text } = await recognize(path), parsed = parseInvoice(rows);
      if (!parsed.items.length) $('err').textContent = 'No items found. Add them by hand on the next screen.';
      await review(parsed, imageRef, text);
    } catch (e) { $('err').textContent = `Could not read the invoice (${e.message}). You can enter it manually.`; $('cam').disabled = false; $('cam').textContent = 'Take photo'; }
  };
}

async function review(parsed, imageRef = null, ocrText = '') {
  statedTotal = parsed.statedTotal ?? null;
  draft = { header: { ...parsed.header }, imageRef, ocrText, updateCost: true, rows: [] };
  for (const it of parsed.items) draft.rows.push(await mk(it));
  draw();
}
async function mk(it) {
  const m = it.name ? await matchProduct(it.name) : { product: null, suggest: null };
  return { name: it.name, quantity: it.quantity, unitPrice: it.unitPrice, low: it.confidence === 'low', match: m.product, suggest: m.suggest, create: false, sellPrice: '' };
}

function rowHtml(r, i) {
  const line = (Number(r.quantity) || 0) * (Number(r.unitPrice) || 0);
  const status = r.match ? `<span class="ok">Adds to ${esc(r.match.name)}: ${r.match.quantity} → ${r.match.quantity + (Number(r.quantity) || 0)}</span>`
    : `<b>New product detected.</b>${r.suggest ? ` <button class="lnk" data-use="${i}">Use ${esc(r.suggest.name)}</button>` : ''}
       <label class="chk"><input type="checkbox" data-create="${i}" ${r.create ? 'checked' : ''}>Create this product</label>
       ${r.create ? `<label>Selling price</label><input data-k="sellPrice" data-i="${i}" inputmode="decimal" value="${esc(r.sellPrice)}">` : '<small>Skipped unless you tick Create.</small>'}`;
  return `<div class="row ${r.low ? 'warn' : ''}">${r.low ? '<small class="err">Check this row: the numbers may be misread.</small>' : ''}
    <input data-k="name" data-i="${i}" value="${esc(r.name)}" placeholder="Product name">
    <div class="qp"><input data-k="quantity" data-i="${i}" inputmode="decimal" value="${esc(r.quantity)}" placeholder="Qty"><span>×</span>
    <input data-k="unitPrice" data-i="${i}" inputmode="decimal" value="${esc(r.unitPrice)}" placeholder="Unit price"><button class="x" data-rm="${i}" aria-label="Remove row">✕</button></div>
    <div class="ln"><span>Line total</span><b>${money(line)}</b></div>${status}</div>`;
}

function draw(err = '', dup = false) {
  const h = draft.header, sum = draft.rows.reduce((a, r) => a + (Number(r.quantity) || 0) * (Number(r.unitPrice) || 0), 0);
  host.innerHTML = `<h2>Scanned invoice</h2>
  <label>Supplier</label><input data-h="supplier" value="${esc(h.supplier)}"><label>Invoice number</label><input data-h="invoiceNo" value="${esc(h.invoiceNo)}">
  <label>Invoice date</label><input data-h="date" type="date" value="${esc(h.date)}">
  ${draft.rows.map(rowHtml).join('')}<button class="btn alt" id="addrow">+ Add row</button>
  <div class="ln"><span>Items total</span><b>${money(sum)}</b></div>
  ${statedTotal != null && Math.abs(statedTotal - sum) > 1 ? `<div class="err">The invoice says ${money(statedTotal)}. Check the rows.</div>` : ''}
  <label class="chk"><input type="checkbox" id="uc" ${draft.updateCost ? 'checked' : ''}>Update buying prices from this invoice</label>
  <div class="err" id="err">${esc(err)}</div>${dup ? '<button class="btn alt" id="anyway">Add anyway</button>' : ''}
  <div class="two"><button class="btn alt" id="cancel">Cancel</button><button class="btn" id="ok">Confirm and add to inventory</button></div>`;
  host.querySelectorAll('[data-h]').forEach(e => (e.oninput = () => (draft.header[e.dataset.h] = e.value)));
  host.querySelectorAll('[data-k]').forEach(e => {
    e.oninput = () => (draft.rows[e.dataset.i][e.dataset.k] = e.value);
    e.onchange = async () => { const r = draft.rows[e.dataset.i];
      if (e.dataset.k === 'name') { const m = await matchProduct(r.name); r.match = m.product; r.suggest = m.suggest; }
      draw(); };
  });
  host.querySelectorAll('[data-create]').forEach(e => (e.onchange = () => { draft.rows[e.dataset.create].create = e.checked; draw(); }));
  host.querySelectorAll('[data-use]').forEach(e => (e.onclick = () => { const r = draft.rows[e.dataset.use]; r.match = r.suggest; r.suggest = null; draw(); }));
  host.querySelectorAll('[data-rm]').forEach(e => (e.onclick = () => { draft.rows.splice(e.dataset.rm, 1); draw(); }));
  $('addrow').onclick = async () => { draft.rows.push(await mk({ name: '', quantity: '', unitPrice: '', confidence: 'high' })); draw(); };
  $('uc').onchange = (e) => (draft.updateCost = e.target.checked);
  $('cancel').onclick = done;
  const submit = (allow) => async () => {
    try { const r = await confirmInvoice(draft, { allowDuplicate: allow }); host.innerHTML = `<h2>Stock added</h2><p class="sub">${r.items} item${r.items === 1 ? '' : 's'} · ${money(r.total)}</p><button class="btn" id="fin">Done</button>`; $('fin').onclick = done; }
    catch (e) { draw(e.message, e.code === 'DUPLICATE'); }
  };
  $('ok').onclick = submit(false); $('anyway')?.addEventListener('click', submit(true));
}
