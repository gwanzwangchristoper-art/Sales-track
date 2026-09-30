import { hasAdmin, createAdmin, login, currentUser, lock } from '../auth/auth.js';
import { linkDevice, heartbeat } from '../cloud/devices.js';
import { scanQr } from '../cloud/qr.js';
import { can } from '../auth/permissions.js';
import { getSetting } from '../db/db.js';
import { biometricReady, unlockWithBiometric } from '../auth/biometric.js';
import { renderHome } from './home.js';
import { renderHistory } from './history.js';
import { renderRecords } from './records.js';
import { renderInventory } from './inventory.js';
import { renderAccounts } from './accounts.js';
const root = document.getElementById('app');
const el = (h) => { root.innerHTML = h; };
const $ = (id) => document.getElementById(id);
const val = (id) => $(id).value.trim();
const fail = (e) => ($('err').textContent = e.message);

export async function start() { await heartbeat(); (await hasAdmin()) ? loginScreen() : welcome(); } // heartbeat also learns if this device was revoked

function welcome() {
  el(`<main><h1>Sales Track Calculator</h1><p class="sub">Calculate, sell and keep your stock right.</p>
  <button class="btn" id="a">Create account</button><button class="btn alt" id="b">Link to existing admin</button></main>`);
  $('a').onclick = adminForm; $('b').onclick = linkForm;
}
function adminForm() {
  el(`<main><h2>Create admin account</h2>
  <label>Full name</label><input id="n"><label>Username or email</label><input id="u" autocapitalize="none">
  <label>Password (8+ characters)</label><input id="p" type="password">
  <label>Business name (optional)</label><input id="bn"><label>Phone (optional)</label><input id="ph" type="tel">
  <div class="err" id="err"></div><button class="btn" id="go">Create account</button></main>`);
  $('go').onclick = () => createAdmin({ fullName: val('n'), username: val('u'), password: $('p').value, businessName: val('bn'), phone: val('ph') }).then(() => shell()).catch(fail);
}
function linkForm() {
  el(`<main><h2>Link to admin</h2><p class="sub">Scan the QR on the admin's Add device screen, or type the code. Internet is needed for this step.</p>
  <label>Pairing code</label><input id="c" autocapitalize="characters" autocomplete="off"><button class="btn alt" id="qr">Scan QR code</button><label>Your name</label><input id="n">
  <label>Username</label><input id="u" autocapitalize="none"><label>Password (8+ characters)</label><input id="p" type="password">
  <div class="err" id="err"></div><button class="btn" id="go">Link this device</button></main>`);
  $('qr').onclick = () => scanQr().then(v => v && ($('c').value = v)).catch(() => fail(new Error('Could not open the camera. Type the code instead.')));
  $('go').onclick = () => { $('go').disabled = true; linkDevice({ code: val('c'), fullName: val('n'), username: val('u'), password: $('p').value }).then(() => shell()).catch(e => { fail(e); $('go').disabled = false; }); };
}
async function loginScreen() {
  const last = (await getSetting('last_user')) || '', bio = last && (await biometricReady(last));
  el(`<main><h1>Welcome back</h1>${bio ? '<button class="btn" id="bio">Unlock with fingerprint or face</button>' : ''}
  <label>Username</label><input id="u" autocapitalize="none" value="${last.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))}">
  <label>Password</label><input id="p" type="password"><div class="err" id="err"></div>
  <button class="btn ${bio ? 'alt' : ''}" id="go">Unlock</button><button class="btn alt" id="lk">Link a new user</button></main>`);
  $('go').onclick = () => login(val('u'), $('p').value).then(() => shell()).catch(fail); $('lk').onclick = linkForm;
  if (bio) $('bio').onclick = () => unlockWithBiometric(last).then(() => shell()).catch(fail);
}
export const lockNow = () => { lock(); loginScreen(); };

const TABS = [['home','Home'],['history','History'],['records','Records','view_analysis'],['inventory','Inventory'],['accounts','Accounts']];
function shell(tab = 'home') {
  const u = currentUser();
  const tabs = TABS.filter(t => !t[2] || can(u, t[2]));
  const body = { home: '', history: '',
    records: '', inventory: '',
    accounts: '' }[tab];
  el(`<main>${body}</main><nav>${tabs.map(t => `<button class="${t[0] === tab ? 'on' : ''}" data-t="${t[0]}">${t[1]}</button>`).join('')}</nav>`);
  if (tab === 'home') renderHome(root.querySelector('main'));
  if (tab === 'history') renderHistory(root.querySelector('main'));
  if (tab === 'records') renderRecords(root.querySelector('main'));
  if (tab === 'inventory') renderInventory(root.querySelector('main'));
  if (tab === 'accounts') renderAccounts(root.querySelector('main'), () => { lock(); loginScreen(); });
  root.querySelectorAll('nav button').forEach(b => (b.onclick = () => shell(b.dataset.t)));
  $('lock')?.addEventListener('click', () => { lock(); loginScreen(); });
}
