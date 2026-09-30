import { currentUser } from '../auth/auth.js';
import { can, ALL } from '../auth/permissions.js';
import { formatCode } from '../auth/crypto.js';
import { cloudEnabled, cloudConfigured, connectAdmin, createPairing, refreshDevices, listUsers, revokeDevice, setPermission } from '../cloud/devices.js';
import { qrDataUrl } from '../cloud/qr.js';
import { renderStockSettings } from './inventory.js';
import { getSetting, q } from '../db/db.js';
import { renderNotifications, renderAudit, renderConflicts } from './review.js';
import { unreadCount } from '../notify/notify.js';
import { syncNow, syncStatus } from '../sync/engine.js';
import { withReauth } from './dialog.js';
import { reauthenticate } from '../auth/auth.js';
import { AUTO_LOCK_CHOICES, getAutoLockMinutes, setAutoLockMinutes } from '../auth/security.js';
import { biometricSupported, biometricEnabled, enableBiometric, disableBiometric } from '../auth/biometric.js';
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const LABEL = { calculate: 'Calculate', sell: 'Record sales', view_history: 'View history', edit_products: 'Add and edit products', adjust_stock: 'Add and remove stock',
  scan_invoices: 'Scan invoices', view_analysis: 'View analysis', export: 'Export reports', change_settings: 'Change settings', corrections: 'Make corrections', link_devices: 'Link devices' };
const ago = (t) => { if (!t) return 'Never'; const m = Math.round((Date.now() - new Date(t)) / 60000); return m < 1 ? 'Just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`; };

export async function renderAccounts(host, onLock) {
  const u = currentUser(), admin = u.role === 'admin', on = await cloudEnabled();
  host.innerHTML = `<h2>${esc(u.full_name)}</h2><p class="sub">${admin ? 'Owner / Admin' : 'Authorized user'}</p>
  <button class="btn alt" id="lock">Lock app</button><div id="a_nav"></div><div id="a_cloud"></div><div id="a_sync"></div><div id="a_dev"></div><div id="a_users"></div>`;
  $('lock').onclick = onLock;
  const unread = await unreadCount(), open = admin ? (await q("SELECT COUNT(*) n FROM sync_conflicts WHERE status='open'"))[0].n : 0, back = () => renderAccounts(host, onLock);
  $('a_nav').innerHTML = `<button class="btn alt" id="n_btn">Notifications${unread ? ` (${unread})` : ''}</button>${admin ? `<button class="btn alt" id="c_btn">Review conflicts${open ? ` (${open})` : ''}</button><button class="btn alt" id="au_btn">Audit log</button>` : ''}`;
  $('n_btn').onclick = () => renderNotifications(host, back); $('c_btn')?.addEventListener('click', () => renderConflicts(host, back)); $('au_btn')?.addEventListener('click', () => renderAudit(host, back));
  if (admin && !on) cloudCard(host, onLock);
  if (on) await syncCard(host, onLock);
  if (on || admin) await deviceList(host, onLock, on);
  if (admin && on) await userList();
  if (can(u, 'change_settings')) await renderStockSettings(host);
  await securityCard(host, u, can(u, 'change_settings')); // security settings
}

function cloudCard(host, onLock) {
  if (!cloudConfigured()) return ($('a_cloud').innerHTML = '<div class="row"><b>Multiple devices</b><br><small>Cloud is not set up yet. Add your Supabase URL and key in src/cloud/config.js.</small></div>');
  $('a_cloud').innerHTML = `<div class="row"><b>Connect to the cloud</b><br><small>Needed to link other devices and back up. Everything else keeps working offline.</small>
  <label>Email</label><input id="c_e" type="email" autocapitalize="none"><label>Cloud password (8+ characters)</label><input id="c_p" type="password">
  <div class="err" id="c_err"></div><button class="btn" id="c_go">Connect</button></div>`;
  $('c_go').onclick = async () => { $('c_go').disabled = true;
    try { await connectAdmin({ email: $('c_e').value.trim(), password: $('c_p').value }); renderAccounts(host, onLock); }
    catch (e) { $('c_err').textContent = e.message; $('c_go').disabled = false; } };
}

async function deviceList(host, onLock, on) {
  const u = currentUser(), me = await getSetting('device_id'), devs = await refreshDevices();
  $('a_dev').innerHTML = `<h2>Connected devices</h2>${devs.map(d => `<div class="row"><b>${esc(d.name)}</b> ${d.id === me ? '<small>(this device)</small>' : ''}
    <div class="ln"><span>${d.status === 'active' ? '<span class="ok">Active</span>' : '<span class="err">Revoked</span>'}</span><small>Last synchronized: ${ago(d.last_sync)}</small></div>
    ${can(u, 'revoke_devices') && d.status === 'active' && d.id !== me && d.name !== 'Admin device' ? `<button class="btn alt" data-rv="${d.id}">Revoke device</button>` : ''}</div>`).join('')}
    ${on && can(u, 'link_devices') ? '<button class="btn" id="d_add">Add device</button>' : ''}<div class="err" id="d_err"></div>`;
  $('a_dev').onclick = async (e) => {
    const id = e.target.dataset.rv; if (!id) return;
    if (!e.target.dataset.armed) { e.target.dataset.armed = 1; e.target.textContent = 'Tap again to revoke'; return; } // two taps, so it can't happen by accident
    try { await withReauth(() => revokeDevice(id), reauthenticate); renderAccounts(host, onLock); } catch (err) { $('d_err').textContent = err.message; }
  };
  $('d_add')?.addEventListener('click', async () => {
    try {
      const code = await createPairing(), img = await qrDataUrl(code);
      host.innerHTML = `<h2>Add device</h2><p class="sub">On the other device choose Link to existing admin, then scan this QR or type the code. It works once and expires in 5 minutes.</p>
      <div style="text-align:center"><img src="${img}" alt="Pairing QR code" width="240" height="240"><div class="total" style="font-size:1.8rem;letter-spacing:2px">${formatCode(code)}</div></div>
      <button class="btn" id="done">Done</button>`;
      $('done').onclick = () => renderAccounts(host, onLock);
    } catch (err) { $('d_err').textContent = err.message; }
  });
}

async function userList() {
  const us = await listUsers();
  if (!us.length) return;
  $('a_users').innerHTML = `<h2>Users</h2><p class="sub">Everything is allowed unless you switch it off.</p>${us.map(x => { const p = JSON.parse(x.permissions || '{}');
    return `<details class="row"><summary><b>${esc(x.full_name)}</b> <small>${x.status === 'active' ? '' : '(revoked)'}</small></summary>
    ${ALL.map(k => `<label class="chk"><input type="checkbox" data-u="${x.id}" data-p="${k}" ${p[k] !== false ? 'checked' : ''}>${LABEL[k]}</label>`).join('')}</details>`; }).join('')}
    <div class="err" id="u_err"></div>`;
  $('a_users').onchange = async (e) => { const { u, p } = e.target.dataset; if (!u) return;
    try { await withReauth(() => setPermission(u, p, e.target.checked), reauthenticate); $('u_err').textContent = ''; } catch (err) { e.target.checked = !e.target.checked; $('u_err').textContent = err.message; } };
}

async function syncCard(host, onLock) {
  const s = await syncStatus();
  $('a_sync').innerHTML = `<div class="row"><b>Synchronization</b>
  <div class="ln"><span>Waiting to upload</span><b>${s.pending}</b></div><div class="ln"><span>Last synchronized</span><span>${ago(s.last)}</span></div>
  ${s.error ? `<div class="err">${esc(s.error)}</div>` : ''}
  ${s.rejected ? `<div class="err">${s.rejected} item(s) were refused by the cloud. The admin needs to review them.</div>` : ''}
  ${s.conflicts ? `<div class="err">${s.conflicts} item(s) need admin review.</div>` : ''}
  <button class="btn alt" id="s_now">Sync now</button></div>`;
  $('s_now').onclick = async () => { $('s_now').disabled = true; $('s_now').textContent = 'Syncing…'; await syncNow(); renderAccounts(host, onLock); };
}

async function securityCard(host, u, canSet) {
  const minutes = await getAutoLockMinutes(), bioOk = await biometricSupported(), bioOn = bioOk && (await biometricEnabled());
  host.insertAdjacentHTML('beforeend', `<div class="row"><b>Security</b>
    ${canSet ? `<label>Lock the app after</label><select id="al">${AUTO_LOCK_CHOICES.map(m => `<option value="${m}" ${m === minutes ? 'selected' : ''}>${m} minute${m > 1 ? 's' : ''} without use</option>`).join('')}</select>` : `<div class="ln"><span>Locks after</span><b>${minutes} min</b></div>`}
    ${bioOk ? `<label class="chk"><input type="checkbox" id="bio" ${bioOn ? 'checked' : ''}>Unlock with fingerprint or face</label>` : ''}<div class="err" id="sec_err"></div></div>`);
  $('al')?.addEventListener('change', async (e) => { try { await setAutoLockMinutes(e.target.value); $('sec_err').textContent = ''; } catch (err) { $('sec_err').textContent = err.message; } });
  $('bio')?.addEventListener('change', async (e) => {
    try { e.target.checked ? await withReauth(enableBiometric, reauthenticate) : await disableBiometric(); $('sec_err').textContent = ''; }
    catch (err) { e.target.checked = !e.target.checked; $('sec_err').textContent = err.message; }
  });
}
