import { searchProducts, addProduct } from '../domain/products.js';
import { saveTransaction, saveCalculation } from '../domain/sales.js';
import { scanBarcode } from '../cloud/qr.js';
import { confirmSale } from '../domain/inventory.js';
import { evaluate, money } from '../domain/calculator.js';

// The open transaction lives in memory so switching tabs never loses it.
let lines = [], mode = 'sale', expr = '';
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const total = () => lines.reduce((a, l) => a + (Number(l.quantity) || 0) * (Number(l.price) || 0), 0);

export function renderHome(host) {
  host.innerHTML = `<div class="seg"><button data-m="sale" class="${mode === 'sale' ? 'on' : ''}">Sale</button>
    <button data-m="math" class="${mode === 'math' ? 'on' : ''}">Calculator</button></div><div id="pane"></div>`;
  host.querySelectorAll('.seg button').forEach(b => (b.onclick = () => { mode = b.dataset.m; renderHome(host); }));
  mode === 'sale' ? salePane() : mathPane();
}

function salePane() {
  $('pane').innerHTML = `<div class="two"><input id="s" placeholder="Search product, SKU or barcode" autocomplete="off"><button class="btn alt" id="scan" style="flex:0 0 96px;margin:0">Scan</button></div><div id="res"></div>
  <div id="lines"></div><div class="totalbar"><span>Grand total</span><span class="total" id="gt"></span></div>
  <div class="err" id="err"></div><div class="two"><button class="btn alt" id="clr">Clear</button><button class="btn" id="eq">=</button></div>
  <div id="summary"></div>`;
  drawLines();
  $('s').oninput = async (e) => {
    const t = e.target.value.trim();
    if (!t) return ($('res').innerHTML = '');
    const r = await searchProducts(t);
    $('res').innerHTML = r.map(p => `<button class="row pick" data-id="${p.id}"><b>${esc(p.name)}</b><br>
      <small>${money(p.sell_price)} · ${p.quantity} in stock</small></button>`).join('') ||
      `<div class="row">Product not found<button class="btn" id="new">+ Add new product</button></div>`;
    $('res').querySelectorAll('.pick').forEach(b => (b.onclick = () => {
      const p = r.find(x => x.id === b.dataset.id); addLine(p); $('s').value = ''; $('res').innerHTML = '';
    }));
    $('new')?.addEventListener('click', () => newProductForm(t));
  };
  $('scan').onclick = async () => { try { const code = await scanBarcode(); if (code) { $('s').value = code; $('s').dispatchEvent(new Event('input')); } } catch { $('err').textContent = 'Could not open the camera. Type the code instead.'; } };
  $('clr').onclick = () => { lines = []; $('summary').innerHTML = ''; drawLines(); };
  $('eq').onclick = async () => {
    try {
      const r = await saveTransaction(lines.map(l => ({ ...l, quantity: Number(l.quantity), price: Number(l.price) })));
      $('summary').innerHTML = `<div class="row"><b>Transaction summary</b>${lines.map(l =>
        `<div class="ln"><span>${esc(l.name)}<br><small>${l.quantity} × ${money(l.price)}</small></span><span>${money(l.quantity * l.price)}</span></div>`).join('')}
        <div class="ln"><b>Grand total</b><b>${money(r.total)}</b></div><small>${r.receipt} saved to history.</small><div class="two"><button class="btn alt" id="nos">Not a sale</button><button class="btn" id="cs">Confirm sale</button></div><div class="err" id="cerr"></div></div>`;
      $('nos').onclick = () => ($('summary').innerHTML = '<p class="sub">Kept as a calculation. Stock unchanged.</p>');
      $('cs').onclick = async () => {
        try { const low = await confirmSale(r.saleId);
          $('summary').innerHTML = `<div class="row"><b>Sale confirmed</b><br>${r.receipt} · ${money(r.total)}${low.length ? '<br><span class="err">Low stock: ' + low.map(esc).join(', ') + '</span>' : ''}</div>`;
        } catch (e) { $('cerr').textContent = e.message; }
      };
      lines = []; drawLines();
    } catch (e) { $('err').textContent = e.message; }
  };
}

function addLine(p) {
  const hit = lines.find(l => l.productId === p.id);
  hit ? hit.quantity = Number(hit.quantity) + 1 : lines.push({ productId: p.id, name: p.name, quantity: 1, price: p.sell_price, cost: p.buy_price });
  drawLines();
}

function drawLines() {
  $('lines').innerHTML = lines.map((l, i) => `<div class="row"><b>${esc(l.name)}</b>
    <div class="qp"><input data-i="${i}" data-k="quantity" inputmode="decimal" value="${l.quantity}" aria-label="Quantity">
    <span>×</span><input data-i="${i}" data-k="price" inputmode="decimal" value="${l.price}" aria-label="Price">
    <button class="x" data-rm="${i}" aria-label="Remove">✕</button></div></div>`).join('');
  $('lines').querySelectorAll('input').forEach(inp => (inp.oninput = () => { lines[inp.dataset.i][inp.dataset.k] = inp.value; $('gt').textContent = money(total()); }));
  $('lines').querySelectorAll('[data-rm]').forEach(b => (b.onclick = () => { lines.splice(b.dataset.rm, 1); drawLines(); }));
  $('gt').textContent = money(total());
}

// Add a product without leaving the sale; on save it joins the current transaction.
function newProductForm(name) {
  $('res').innerHTML = `<div class="row"><h2>New product</h2>
  <label>Name</label><input id="f_n" value="${/^\d{6,14}$/.test(name) ? '' : esc(name)}"><label>Selling price</label><input id="f_p" inputmode="decimal">
  <label>Quantity in stock</label><input id="f_q" inputmode="decimal"><label>Category</label><input id="f_c">
  <details><summary>More (optional)</summary><label>SKU</label><input id="f_sku"><label>Barcode</label><input id="f_bc" value="${/^\d{6,14}$/.test(name) ? esc(name) : ''}">
  <label>Buying price</label><input id="f_b" inputmode="decimal"><label>Low-stock alert at</label><input id="f_t" inputmode="decimal"></details>
  <div class="err" id="ferr"></div><button class="btn" id="f_go">Save and add to sale</button></div>`;
  $('f_go').onclick = async () => {
    try {
      const p = await addProduct({ name: $('f_n').value, sellPrice: $('f_p').value, quantity: $('f_q').value, category: $('f_c').value,
        sku: $('f_sku').value, barcode: $('f_bc').value, buyPrice: $('f_b').value, threshold: $('f_t').value });
      addLine(p); $('res').innerHTML = ''; $('s').value = '';
    } catch (e) { $('ferr').textContent = e.message; }
  };
}

function mathPane() {
  const keys = ['C','(',')','÷','7','8','9','×','4','5','6','-','1','2','3','+','0','.','⌫','='];
  $('pane').innerHTML = `<div class="disp" id="d">${esc(expr) || '0'}</div><div class="err" id="err"></div>
  <p class="sub">Ordinary calculations never change your stock.</p>
  <div class="keys">${keys.map(k => `<button class="k ${k === '=' ? 'eqk' : ''}" data-k="${k}">${k}</button>`).join('')}</div>`;
  $('pane').querySelectorAll('.k').forEach(b => (b.onclick = async () => {
    const k = b.dataset.k; $('err').textContent = '';
    if (k === 'C') expr = ''; else if (k === '⌫') expr = expr.slice(0, -1);
    else if (k === '=') {
      try { const before = expr, r = await saveCalculation(expr); expr = String(r); $('d').textContent = `${before} = ${r.toLocaleString()}`; return; }
      catch (e) { $('err').textContent = e.message; return; }
    } else expr += k;
    $('d').textContent = expr || '0';
  }));
}
