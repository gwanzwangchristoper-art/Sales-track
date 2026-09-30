import { q, run } from '../db/db.js';
import { resolveConflict, retryRejected, syncNow } from '../sync/engine.js';
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const when = (t) => new Date(t).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
const back = (fn) => `<button class="btn alt" id="bk">Back</button>`;

export async function renderNotifications(host, onBack) {
  const rows = await q('SELECT * FROM notifications ORDER BY created_at DESC LIMIT 50');
  host.innerHTML = `<h2>Notifications</h2>${rows.map(n => `<div class="row ${n.is_read ? '' : 'warn'}"><b>${esc(n.title)}</b><br>${esc(n.body)}<br><small>${when(n.created_at)}</small></div>`).join('') || '<p class="sub">Nothing yet.</p>'}${back()}`;
  $('bk').onclick = onBack;
  await run('UPDATE notifications SET is_read=1 WHERE is_read=0');
}

const FIELD = { name: 'Name', sku: 'SKU', barcode: 'Barcode', sell_price: 'Selling price', buy_price: 'Buying price', low_stock_threshold: 'Low-stock alert', supplier: 'Supplier', description: 'Description', category_id: 'Category', active: 'Active' };
const val = (s) => { try { const v = JSON.parse(s); return v === null || v === '' ? '(empty)' : String(v); } catch { return String(s); } };

export async function renderReview(host, onBack) {
  const cs = await q(`SELECT c.*, p.name pname, s.receipt_no FROM sync_conflicts c LEFT JOIN products p ON p.id=c.row_id AND c.table_name='products'
    LEFT JOIN sales s ON s.id=c.row_id AND c.table_name='sales' WHERE c.status='open' ORDER BY c.created_at`);
  const dev = Object.fromEntries((await q('SELECT id,name FROM devices')).map(d => [d.id, d.name]));
  let rejected = 0;
  for (const t of ['categories', 'products', 'sales', 'sale_items', 'calculations', 'invoices', 'invoice_items', 'inventory_transactions', 'audit_logs'])
    rejected += (await q(`SELECT COUNT(*) n FROM ${t} WHERE sync_status='REJECTED'`))[0].n;
  const card = (c) => {
    if (c.kind === 'field') return `<div class="row warn"><b>${esc(c.pname)}</b>: ${FIELD[c.field] || esc(c.field)}<br><small>Two devices changed this differently.</small>
      <div class="ln"><span>This device</span><b>${esc(val(c.local_value))}</b></div><div class="ln"><span>Other device</span><b>${esc(val(c.remote_value))}</b></div>
      <div class="two"><button class="btn alt" data-r="${c.id}" data-c="mine">Keep this device's</button><button class="btn alt" data-r="${c.id}" data-c="theirs">Use other device's</button></div></div>`;
    const d = JSON.parse(c.detail || '[]');
    if (c.kind === 'negative_stock') return `<div class="row warn"><b>${esc(c.pname)}</b> is at ${esc(c.local_value)}<br><small>Several devices each sold stock they thought was available. Every sale is kept. Add stock or correct a sale to fix the count.</small>
      ${d.slice(0, 6).map(x => `<div class="ln"><span>${esc(dev[x.device_id] || 'Device')} · ${esc(x.reason)}</span><b>${x.delta > 0 ? '+' : ''}${x.delta}</b></div>`).join('')}
      <button class="btn alt" data-r="${c.id}" data-c="acknowledge">Mark as reviewed</button></div>`;
    return `<div class="row warn"><b>${esc(c.receipt_no || 'A sale')}</b> was corrected on two devices<br><small>Together the corrections undo more than was sold. Check the sale in History.</small>
      <button class="btn alt" data-r="${c.id}" data-c="acknowledge">Mark as reviewed</button></div>`;
  };
  host.innerHTML = `<h2>Sync issues</h2>${cs.map(card).join('') || '<p class="sub">Nothing needs review.</p>'}
  ${rejected ? `<div class="row"><b>${rejected} change(s) refused by the cloud</b><br><small>Usually a permission was removed. They are kept, not deleted. Retry after fixing permissions.</small><button class="btn alt" id="retry">Retry them</button></div>` : ''}${back()}`;
  $('bk').onclick = onBack;
  $('retry')?.addEventListener('click', async () => { await retryRejected(); syncNow(); renderReview(host, onBack); });
  host.onclick = async (e) => { const id = e.target.dataset.r; if (!id) return;
    try { await resolveConflict(id, e.target.dataset.c); syncNow(); renderReview(host, onBack); } catch (err) { e.target.insertAdjacentText('afterend', ' ' + err.message); } };
}

const ACTION = { admin_created: 'Admin account created', login: 'Signed in', sale_confirmed: 'Sale confirmed', sale_corrected: 'Sale corrected', stock_adjusted: 'Stock adjusted',
  product_created: 'Product added', product_edited: 'Product edited', invoice_confirmed: 'Invoice added to stock', setting_changed: 'Setting changed', device_linked: 'Device linked',
  device_revoked: 'Device revoked', permission_changed: 'Permission changed', cloud_connected: 'Cloud connected', pairing_code_created: 'Pairing code created', conflict_resolved: 'Conflict resolved' };
const show = (s) => { try { const v = JSON.parse(s); if (v === null) return ''; if (typeof v !== 'object') return String(v);
  return Object.entries(v).map(([k, x]) => `${k}: ${x && typeof x === 'object' ? JSON.stringify(x) : x}`).join(', ').slice(0, 160); } catch { return String(s ?? ''); } };
let af = { action: '', hideLogin: true };

export async function renderAudit(host, onBack) {
  host.innerHTML = `<h2>Audit log</h2><p class="sub">Every important action. Records are never edited or deleted.</p>
  <select id="af_a"><option value="">All actions</option>${Object.entries(ACTION).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>
  <label class="chk"><input type="checkbox" id="af_l" ${af.hideLogin ? 'checked' : ''}>Hide sign-ins</label><div id="al"></div><button class="btn alt" id="more" hidden>Load more</button>${back()}`;
  $('af_a').value = af.action; $('bk').onclick = onBack;
  let off = 0;
  const draw = async (reset) => {
    if (reset) { off = 0; $('al').innerHTML = ''; }
    const rows = await q(`SELECT a.*, u.full_name who, d.name dev FROM audit_logs a LEFT JOIN users u ON u.id=a.user_id LEFT JOIN devices d ON d.id=a.device_id
      WHERE (?='' OR a.action=?) AND (?=0 OR a.action<>'login') ORDER BY a.created_at DESC LIMIT 30 OFFSET ?`, [af.action, af.action, af.hideLogin ? 1 : 0, off]);
    $('al').insertAdjacentHTML('beforeend', rows.map(a => `<div class="row"><small>${when(a.created_at)} · ${esc(a.who || 'Unknown')} · ${esc(a.dev || 'device')}</small><br><b>${esc(ACTION[a.action] || a.action)}</b>
      ${a.old_value && a.old_value !== 'null' ? `<div><small>Before:</small> ${esc(show(a.old_value))}</div>` : ''}${a.new_value && a.new_value !== 'null' ? `<div><small>After:</small> ${esc(show(a.new_value))}</div>` : ''}
      ${a.reason ? `<div><small>Reason:</small> ${esc(a.reason)}</div>` : ''}</div>`).join('') || (reset ? '<p class="sub">No entries.</p>' : ''));
    off += rows.length; $('more').hidden = rows.length < 30;
  };
  $('af_a').onchange = (e) => { af.action = e.target.value; draw(true); };
  $('af_l').onchange = (e) => { af.hideLogin = e.target.checked; draw(true); };
  $('more').onclick = () => draw(false);
  draw(true);
}
