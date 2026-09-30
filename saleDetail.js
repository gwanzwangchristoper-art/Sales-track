import { getSaleDetail, correctSale, voidSale } from '../domain/corrections.js';
import { can } from '../auth/permissions.js';
import { currentUser } from '../auth/auth.js';
import { money } from '../domain/calculator.js';
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const STATUS = { calculated: 'Not confirmed', confirmed: 'Confirmed', corrected: 'Corrected', voided: 'Voided' };
const brief = (v) => { try { const o = JSON.parse(v); return o ? [o.receipt, o.total != null ? money(o.total) : '', (o.items || []).join(', ')].filter(Boolean).join(' · ') || v : ''; } catch { return v || ''; } };

export async function openSale(host, id, back) {
  const d = await getSaleDetail(id), s = d.sale, u = currentUser();
  host.innerHTML = `<h2>${esc(s.receipt_no)}</h2><div class="row"><b>${money(s.total)}</b> · <span class="${s.status === 'confirmed' ? 'ok' : ''}">${STATUS[s.status] || s.status}</span>
    <br><small>${new Date(s.created_at).toLocaleString()} · ${esc(s.who)}</small>
    ${d.corrects ? `<br><small>Corrects <a class="lnk" data-go="${d.corrects.id}">${esc(d.corrects.receipt_no)}</a></small>` : ''}
    ${d.replacedBy.map(r => `<br><small>${s.status === 'voided' ? 'Voided' : 'Replaced by'} <a class="lnk" data-go="${r.id}">${esc(r.receipt_no)}</a></small>`).join('')}
    ${s.correction_reason ? `<br><small>Reason: ${esc(s.correction_reason)}</small>` : ''}</div>
  <div class="row">${d.items.map(i => `<div class="ln"><span>${esc(i.product_name)}<br><small>${i.quantity} × ${money(i.unit_price)}</small></span><b>${money(i.subtotal)}</b></div>`).join('')}</div>
  <h2>History of this sale</h2>${d.trail.map(a => `<div class="row"><small>${new Date(a.created_at).toLocaleString()} · ${esc(a.who)}</small><br><b>${esc(a.action.replace(/_/g, ' '))}</b>
    ${a.reason ? `<br><small>Reason: ${esc(a.reason)}</small>` : ''}${a.old_value && a.old_value !== 'null' ? `<br><small>Before: ${esc(brief(a.old_value))}</small>` : ''}
    ${a.new_value && a.new_value !== 'null' ? `<br><small>After: ${esc(brief(a.new_value))}</small>` : ''}</div>`).join('') || '<p class="sub">No changes recorded.</p>'}
  ${s.status === 'confirmed' && can(u, 'corrections') ? '<button class="btn alt" id="fix">Correct or void this sale</button>' : ''}<button class="btn alt" id="bk">Back</button>`;
  $('bk').onclick = back;
  host.querySelectorAll('[data-go]').forEach(a => (a.onclick = () => openSale(host, a.dataset.go, () => openSale(host, id, back))));
  $('fix')?.addEventListener('click', () => form(host, d, () => openSale(host, id, back), back));
}

function form(host, d, again, back) {
  const lines = d.items.map(i => ({ productId: i.product_id, name: i.product_name, quantity: i.quantity, price: i.unit_price, cost: i.unit_cost }));
  host.innerHTML = `<h2>Correct ${esc(d.sale.receipt_no)}</h2><p class="sub">The original stays on record. Its stock is put back and a new linked sale is created.</p>
  ${lines.map((l, i) => `<div class="row"><b>${esc(l.name)}</b><div class="qp"><input data-i="${i}" data-k="quantity" inputmode="decimal" value="${l.quantity}"><span>×</span>
  <input data-i="${i}" data-k="price" inputmode="decimal" value="${l.price}"><button class="x" data-rm="${i}" aria-label="Remove">✕</button></div></div>`).join('')}
  <label>Reason (required)</label><input id="why" placeholder="For example: wrong quantity entered"><div class="err" id="err"></div>
  <button class="btn" id="save">Save correction</button><button class="btn alt" id="void">Void the whole sale</button><button class="btn alt" id="cancel">Cancel</button>`;
  host.querySelectorAll('input[data-k]').forEach(e => (e.oninput = () => (lines[e.dataset.i][e.dataset.k] = e.value)));
  host.querySelectorAll('[data-rm]').forEach(b => (b.onclick = () => { lines.splice(b.dataset.rm, 1); form(host, { ...d, items: lines.map(l => ({ product_id: l.productId, product_name: l.name, quantity: l.quantity, unit_price: l.price, unit_cost: l.cost })) }, again, back); }));
  const go = (fn) => async () => { try { await fn(); back(); } catch (e) { $('err').textContent = e.message; } };
  $('save').onclick = go(() => (lines.length ? correctSale(d.sale.id, { lines, reason: $('why').value }) : Promise.reject(new Error('No lines left. Use Void the whole sale.'))));
  $('void').onclick = go(() => voidSale(d.sale.id, $('why').value));
  $('cancel').onclick = again;
}
