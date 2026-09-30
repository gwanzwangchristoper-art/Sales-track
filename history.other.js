import { loadHistory } from '../domain/sales.js';
import { openSale } from './saleDetail.js';
import { confirmSale } from '../domain/inventory.js';
import { renderSaleDetail } from './saleDetail.js';
import { money } from '../domain/calculator.js';
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
let f = { date: new Date().toLocaleDateString('en-CA'), type: 'all', text: '' };

export async function renderHistory(host) {
  host.innerHTML = `<h2>History</h2><div class="two"><input id="h_d" type="date" value="${f.date}">
  <select id="h_t"><option value="all">All</option><option value="sale">Sales</option><option value="calc">Calculations</option></select></div>
  <input id="h_s" placeholder="Search" value="${esc(f.text)}"><div id="h_list"></div><button class="btn alt" id="more" hidden>Load more</button>`;
  $('h_t').value = f.type;
  let offset = 0;
  const draw = async (reset) => {
    if (reset) { offset = 0; $('h_list').innerHTML = ''; }
    const rows = await loadHistory({ ...f, offset });
    if (reset && !rows.length) $('h_list').innerHTML = '<p class="sub">Nothing recorded for this day yet.</p>';
    $('h_list').insertAdjacentHTML('beforeend', rows.map(r => `<div class="row" ${r.kind === 'sale' ? `data-open="${r.id}"` : ''}><small>${new Date(r.created_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
      · ${r.kind === 'sale' ? esc(r.ref) + (r.corr ? ' · Correction' : ' · Sale') : 'Calculation'} · ${esc(r.who)}</small><div>${esc(r.summary)}</div><b>Total ${money(r.value)}</b>${r.kind === 'sale' ? ` <small>· ${r.status}</small>` : ''}${r.kind === 'sale' ? ` <button class="lnk" data-d="${r.id}">Details</button>` : ''}${r.status === 'calculated' ? `<br><button class="btn alt" data-c="${r.id}">Confirm sale</button>` : ''}</div>`).join(''));
    offset += rows.length; $('more').hidden = rows.length < 30;
  };
  $('h_d').onchange = (e) => { f.date = e.target.value; draw(true); };
  $('h_t').onchange = (e) => { f.type = e.target.value; draw(true); };
  $('h_s').oninput = (e) => { f.text = e.target.value.trim(); draw(true); };
  $('more').onclick = () => draw(false);
  $('h_list').onclick = async (e) => { const id = e.target.dataset.c;
    if (!id) { const row = e.target.closest('[data-open]'); if (row) openSale(row.dataset.open, () => renderHistory(host)); return; }
    try { await confirmSale(id); draw(true); } catch (err) { e.target.insertAdjacentText('afterend', ' ' + err.message); } };
  draw(true);
}
