import { listProducts, lowStockCount, getProduct, productLedger, updateProduct, adjustStock, negativeStockOn, setNegativeStock } from '../domain/inventory.js';
import { addProduct } from '../domain/products.js';
import { can } from '../auth/permissions.js';
import { currentUser } from '../auth/auth.js';
import { scanInvoice } from './invoice.js';
import { scanBarcode } from '../cloud/qr.js';
import { money } from '../domain/calculator.js';
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const isLow = (p) => p.low_stock_threshold > 0 && p.quantity <= p.low_stock_threshold;
let text = '', lowOnly = false, host;

export async function renderInventory(h) {
  host = h; const u = currentUser(), low = await lowStockCount();
  host.innerHTML = `<h2>Inventory</h2><input id="i_s" placeholder="Search products" value="${esc(text)}">
  ${low ? `<button class="banner" id="i_low">${lowOnly ? 'Showing low stock. Tap to show all.' : `Low stock: ${low}. Tap to review.`}</button>` : ''}
  <div id="i_list"></div>
  ${can(u, 'edit_products') ? '<button class="btn" id="i_add">+ Add product</button>' : ''}
  ${can(u, 'scan_invoices') ? '<button class="btn alt" id="i_scan">Scan invoice</button>' : ''}`;
  $('i_s').oninput = (e) => { text = e.target.value; drawList(); };
  $('i_low')?.addEventListener('click', () => { lowOnly = !lowOnly; renderInventory(host); });
  $('i_scan')?.addEventListener('click', () => scanInvoice(host, () => renderInventory(host)));
  $('i_add')?.addEventListener('click', () => form());
  drawList();
}

async function drawList() {
  const u = currentUser(), rows = await listProducts({ text, lowOnly });
  $('i_list').innerHTML = rows.map(p => `<div class="row"><b>${esc(p.name)}</b> ${isLow(p) ? '<span class="badge">LOW STOCK</span>' : ''}
    <div class="ln"><span>Stock ${p.quantity}</span><span>${money(p.sell_price)}</span></div>
    <small>${esc(p.sku || 'No SKU')} · ${esc(p.category || 'No category')}${p.buy_price != null ? ' · Cost ' + money(p.buy_price) : ''}</small>
    <div class="acts"><button data-a="view" data-id="${p.id}">View</button>
    ${can(u, 'edit_products') ? `<button data-a="edit" data-id="${p.id}">Edit</button>` : ''}
    ${can(u, 'adjust_stock') ? `<button data-a="add" data-id="${p.id}">Add stock</button><button data-a="rem" data-id="${p.id}">Remove stock</button>` : ''}</div></div>`).join('')
    || '<p class="sub">No products yet. Tap + Add product to start your inventory.</p>';
  $('i_list').onclick = (e) => { const { a, id } = e.target.dataset; if (a === 'view') detail(id); if (a === 'edit') form(id); if (a === 'add') stock(id, 1); if (a === 'rem') stock(id, -1); };
}

const back = `<button class="btn alt" id="bk">Back</button>`;
const field = (id, label, v = '', extra = '') => `<label>${label}</label><input id="${id}" value="${esc(v)}" ${extra}>`;

async function detail(id) {
  const p = await getProduct(id), led = await productLedger(id);
  host.innerHTML = `<h2>${esc(p.name)}</h2><div class="row">Stock <b>${p.quantity}</b> ${isLow(p) ? '<span class="badge">LOW STOCK</span>' : ''}<br>
  Selling ${money(p.sell_price)}${p.buy_price != null ? ` · Buying ${money(p.buy_price)}` : ''}<br>Alert at ${p.low_stock_threshold || 'not set'}<br>
  ${esc(p.category || '')} ${p.supplier ? '· ' + esc(p.supplier) : ''}</div><h2>Recent stock changes</h2>
  ${led.map(l => `<div class="ln"><span>${new Date(l.created_at).toLocaleString()}<br><small>${esc(l.reason)}${l.note ? ': ' + esc(l.note) : ''}</small></span><b>${l.delta > 0 ? '+' : ''}${l.delta}</b></div>`).join('')}${back}`;
  $('bk').onclick = () => renderInventory(host);
}

function form(id) {
  (async () => {
    const p = id ? await getProduct(id) : {};
    host.innerHTML = `<h2>${id ? 'Edit product' : 'Add product'}</h2>${field('f_n', 'Product name', p.name)}${field('f_p', 'Selling price', p.sell_price, 'inputmode="decimal"')}
    ${id ? '' : field('f_q', 'Quantity in stock', '', 'inputmode="decimal"') + field('f_c', 'Category')}
    ${field('f_b', 'Buying price', p.buy_price, 'inputmode="decimal"')}${field('f_t', 'Low-stock alert at', p.low_stock_threshold, 'inputmode="decimal"')}
    ${field('f_sku', 'SKU', p.sku)}${field('f_bc', 'Barcode', p.barcode)}<button class="btn alt" id="f_scan" type="button">Scan barcode</button>${field('f_sup', 'Supplier', p.supplier)}${field('f_d', 'Description', p.description)}
    <div class="err" id="err"></div><button class="btn" id="save">Save</button>${back}`;
    $('bk').onclick = () => renderInventory(host);
    $('f_scan').onclick = async () => { try { const c = await scanBarcode(); if (c) $('f_bc').value = c; } catch { $('err').textContent = 'Could not open the camera.'; } };
    $('save').onclick = async () => {
      const v = { name: $('f_n').value, sellPrice: $('f_p').value, buyPrice: $('f_b').value, threshold: $('f_t').value, sku: $('f_sku').value,
        barcode: $('f_bc').value, supplier: $('f_sup').value, description: $('f_d').value };
      try { id ? await updateProduct(id, v) : await addProduct({ ...v, quantity: $('f_q').value, category: $('f_c').value }); renderInventory(host); }
      catch (e) { $('err').textContent = e.message; }
    };
  })();
}

const REASONS = { 1: ['Restock', 'Customer return', 'Correction', 'Other'], '-1': ['Damaged', 'Expired', 'Lost or stolen', 'Returned to supplier', 'Other'] };
async function stock(id, sign) {
  const p = await getProduct(id);
  host.innerHTML = `<h2>${sign > 0 ? 'Add' : 'Remove'} stock: ${esc(p.name)}</h2><p class="sub">Currently ${p.quantity}</p>
  ${field('s_q', 'Quantity', '', 'inputmode="decimal"')}<label>Reason</label><select id="s_r">${REASONS[sign].map(r => `<option>${r}</option>`).join('')}</select>
  ${field('s_n', 'Note (optional)')}<div class="err" id="err"></div><button class="btn" id="save">Save</button>${back}`;
  $('bk').onclick = () => renderInventory(host);
  $('save').onclick = async () => {
    try { const low = await adjustStock({ productId: id, delta: sign * Math.abs(Number($('s_q').value)), reason: $('s_r').value, note: $('s_n').value }); renderInventory(host); }
    catch (e) { $('err').textContent = e.message; }
  };
}

// Shown on the Accounts tab for anyone allowed to change settings.
export async function renderStockSettings(main) {
  main.insertAdjacentHTML('beforeend', `<div class="row"><label class="chk"><input type="checkbox" id="neg" ${(await negativeStockOn()) ? 'checked' : ''}>
  Allow selling more than the stock on hand</label><small>Off by default, so stock can't go below zero by accident.</small><div class="err" id="serr"></div></div>`);
  $('neg').onchange = async (e) => { try { await setNegativeStock(e.target.checked); } catch (err) { e.target.checked = !e.target.checked; $('serr').textContent = err.message; } };
}
