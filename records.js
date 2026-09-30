import { dashboard } from '../domain/reports.js';
import { money } from '../domain/calculator.js';
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const RANGES = [['today', 'Today'], ['yesterday', 'Yesterday'], ['week', 'This week'], ['month', 'This month'], ['custom', 'Custom']];
let st = { key: 'today', from: '', to: '' };

export async function renderRecords(host) {
  host.innerHTML = `<h2>Records and analysis</h2><div class="chips">${RANGES.map(([k, l]) => `<button data-k="${k}" class="${st.key === k ? 'on' : ''}">${l}</button>`).join('')}</div>
  ${st.key === 'custom' ? `<div class="two"><input id="r_f" type="date" value="${st.from}"><input id="r_t" type="date" value="${st.to}"></div>` : ''}<div id="r_body"><p class="sub">Loading…</p></div>`;
  host.querySelectorAll('.chips button').forEach(b => (b.onclick = () => { st.key = b.dataset.k; renderRecords(host); }));
  $('r_f')?.addEventListener('change', (e) => { st.from = e.target.value; draw(); });
  $('r_t')?.addEventListener('change', (e) => { st.to = e.target.value; draw(); });
  draw();
}

async function draw() {
  try {
    const d = await dashboard(st.key, st.from, st.to), sold = d.top.reduce((a, t) => a + t.qty, 0);
    $('r_body').innerHTML = `
    <div class="kpi"><div><small>Sales</small><div class="total">${money(d.main.revenue)}</div></div><div><small>Transactions</small><b>${d.main.n}</b></div></div>
    <div class="row"><small>Estimated gross profit</small><br><b>${money(d.profit.profit)}</b>
      ${d.profit.missing ? `<br><small>${d.profit.missing} sold item${d.profit.missing > 1 ? 's have' : ' has'} no buying price and ${d.profit.missing > 1 ? 'are' : 'is'} left out.</small>` : ''}</div>
    <div class="row"><b>Sales over time</b>${chart(d.trend)}</div>
    <div class="row"><b>Top-selling products</b>${d.top.length ? d.top.map(t => `<div class="ln"><span>${esc(t.name)}<br><small>${t.qty} sold</small></span><b>${money(t.revenue)}</b></div>`).join('') : '<p class="sub">No confirmed sales in this period.</p>'}</div>
    <div class="row"><b>Sales so far</b>${[['Today', d.snap.today], ['This week', d.snap.week], ['This month', d.snap.month], ['All time', d.snap.all]].map(([l, s]) =>
      `<div class="ln"><span>${l}<br><small>${s.n} transaction${s.n === 1 ? '' : 's'}</small></span><b>${money(s.revenue)}</b></div>`).join('')}</div>
    <div class="row"><b>Stock</b><div class="ln"><span>Products</span><b>${d.inv.products}</b></div>
      <div class="ln"><span>Stock value at cost</span><b>${money(d.inv.cost_value)}</b></div><div class="ln"><span>Stock value at selling price</span><b>${money(d.inv.sell_value)}</b></div>
      <div class="ln"><span>Low-stock products</span><b>${d.inv.low || 0}</b></div>
      ${d.lowList.map(p => `<small>${esc(p.name)}: ${p.quantity} left (alert at ${p.th})</small><br>`).join('')}</div>`;
  } catch (e) { $('r_body').innerHTML = `<div class="err">${esc(e.message)}</div>`; }
}

// Plain SVG bars: no chart library, so it works offline and stays light.
function chart(pts) {
  if (!pts.length) return '<p class="sub">Nothing to chart yet.</p>';
  const max = Math.max(...pts.map(p => p.value)), w = 300, h = 110, bw = Math.min(28, w / pts.length - 4);
  const step = w / pts.length;
  const bars = pts.map((p, i) => { const bh = Math.max(2, (p.value / max) * h);
    return `<rect x="${i * step + (step - bw) / 2}" y="${h - bh}" width="${bw}" height="${bh}" rx="3" fill="var(--accent)"><title>${esc(p.label)}: ${money(p.value)}</title></rect>`; }).join('');
  const lab = (p) => p.label.length > 2 ? p.label.slice(5) : p.label + ':00';
  return `<svg viewBox="0 0 ${w} ${h + 22}" width="100%" role="img" aria-label="Sales chart, highest ${money(max)}">${bars}
    <text x="0" y="${h + 16}" font-size="11" fill="var(--muted)">${lab(pts[0])}</text>
    <text x="${w}" y="${h + 16}" font-size="11" fill="var(--muted)" text-anchor="end">${lab(pts[pts.length - 1])}</text></svg><small>Highest bar: ${money(max)}</small>`;
}
