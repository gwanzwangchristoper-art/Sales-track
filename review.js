import { loadAudit, auditActions } from '../domain/audit.js';
import { listNotifications, markAllRead } from '../notify/notify.js';
import { listOpenConflicts, resolveConflict } from '../sync/conflicts.js';
import { voidSale } from '../domain/corrections.js';
import { q } from '../db/db.js';
import { money } from '../domain/calculator.js';
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const shortJson = (v) => { if (!v || v === 'null') return ''; try { const o = JSON.parse(v); const t = typeof o === 'object' ? Object.entries(o).map(([k, x]) => `${k}: ${Array.isArray(x) ? x.join(', ') : x}`).join(' · ') : String(o); return t.length > 200 ? t.slice(0, 200) + '…' : t; } catch { return v; } };

export async function renderNotifications(host, back) {
  const rows = await listNotifications(); await markAllRead();
  host.innerHTML = `<h2>Notifications</h2>${rows.map(n => `<div class="row ${n.is_read ? '' : 'warn'}"><b>${esc(n.title)}</b><br>${esc(n.body)}<br><small>${new Date(n.created_at).toLocaleString()}</small></div>`).join('') || '<p class="sub">Nothing yet.</p>'}<button class="btn alt" id="bk">Back</button>`;
  $('bk').onclick = back;
}

export async function renderAudit(host, back) {
  const f = { action: '', date: '', text: '' }, actions = await auditActions();
  host.innerHTML = `<h2>Audit log</h2><p class="sub">Every important action. Records here can't be edited or deleted.</p>
  <select id="au_a"><option value="">All actions</option>${actions.map(a => `<option value="${a}">${esc(a.replace(/_/g, ' '))}</option>`).join('')}</select>
  <input id="au_d" type="date"><input id="au_t" placeholder="Search"><div id="au_l"></div><button class="btn alt" id="more" hidden>Load more</button><button class="btn alt" id="bk">Back</button>`;
  let offset = 0;
  const draw = async (reset) => {
    if (reset) { offset = 0; $('au_l').innerHTML = ''; }
    const rows = await loadAudit({ ...f, offset });
    if (reset && !rows.length) $('au_l').innerHTML = '<p class="sub">No records match.</p>';
    $('au_l').insertAdjacentHTML('beforeend', rows.map(a => `<div class="row"><small>${new Date(a.created_at).toLocaleString()} · ${esc(a.who || 'Unknown')} · ${esc(a.device_name || 'Device')}</small><br>
      <b>${esc(a.action.replace(/_/g, ' '))}</b>${a.reason ? `<br><small>Reason: ${esc(a.reason)}</small>` : ''}
      ${shortJson(a.old_value) ? `<br><small>Before: ${esc(shortJson(a.old_value))}</small>` : ''}${shortJson(a.new_value) ? `<br><small>After: ${esc(shortJson(a.new_value))}</small>` : ''}</div>`).join(''));
    offset += rows.length; $('more').hidden = rows.length < 30;
  };
  $('au_a').onchange = (e) => { f.action = e.target.value; draw(true); }; $('au_d').onchange = (e) => { f.date = e.target.value; draw(true); };
  $('au_t').oninput = (e) => { f.text = e.target.value.trim(); draw(true); };
  $('more').onclick = () => draw(false); $('bk').onclick = back; draw(true);
}

export async function renderConflicts(host, back) {
  const list = await listOpenConflicts();
  const cards = [];
  for (const c of list) {
    const val = (v) => { try { return JSON.parse(v); } catch { return v; } };
    if (c.kind === 'field')
      cards.push(`<div class="row warn"><b>${esc(c.product_name || 'A product')}</b>: ${esc(c.field.replace(/_/g, ' '))}<br><small>${esc(c.device_name || 'A device')} changed it to <b>${esc(val(c.local_value))}</b>. The current value is <b>${esc(val(c.remote_value))}</b>.</small>
        <div class="two"><button class="btn alt" data-c="${c.id}" data-a="remote">Keep current</button><button class="btn" data-c="${c.id}" data-a="local">Use ${esc(val(c.local_value))}</button></div></div>`);
    else if (c.kind === 'negative_stock') {
      const ev = JSON.parse(c.detail || '[]');
      cards.push(`<div class="row warn"><b>${esc(c.product_name || 'A product')}</b> is at ${esc(c.local_value)}<br><small>Devices sold the last units at the same time. Every sale is kept. Recent stock changes:</small>
        ${ev.slice(0, 6).map(e => `<div class="ln"><small>${esc(e.reason)}</small><small>${e.delta > 0 ? '+' : ''}${e.delta}</small></div>`).join('')}
        <small>Use Add stock in Inventory if the real count is higher.</small><button class="btn alt" data-c="${c.id}" data-a="acknowledge">Mark as reviewed</button></div>`);
    } else if (c.kind === 'duplicate_correction') {
      const ids = JSON.parse(c.detail || '{}').sales || [], sales = [];
      for (const id of ids) sales.push((await q('SELECT s.id,s.receipt_no,s.total,s.status,u.full_name who FROM sales s LEFT JOIN users u ON u.id=s.user_id WHERE s.id=?', [id]))[0]);
      cards.push(`<div class="row warn"><b>One sale was corrected twice</b><br><small>Two devices corrected the same sale. Keep the right one and void the other.</small>
        ${sales.filter(Boolean).map(s => `<div class="ln"><span>${esc(s.receipt_no)} · ${esc(s.who)}<br><small>${money(s.total)} · ${esc(s.status)}</small></span>${s.status === 'confirmed' ? `<button class="btn alt" data-void="${s.id}" data-c="${c.id}">Void this one</button>` : ''}</div>`).join('')}
        <button class="btn alt" data-c="${c.id}" data-a="acknowledge">Mark as reviewed</button></div>`);
    }
  }
  host.innerHTML = `<h2>Review conflicts</h2>${cards.join('') || '<p class="sub">Nothing needs review.</p>'}<div class="err" id="err"></div><button class="btn alt" id="bk">Back</button>`;
  $('bk').onclick = back;
  host.onclick = async (e) => {
    const { c, a, void: v } = e.target.dataset; if (!c) return;
    try { if (v) await voidSale(v, 'Duplicate correction'); else await resolveConflict(c, a); renderConflicts(host, back); } catch (err) { $('err').textContent = err.message; }
  };
}
