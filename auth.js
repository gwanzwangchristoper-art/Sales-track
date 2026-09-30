import { q, run, uuid, now, audit, setSetting, getSetting } from '../db/db.js';
import { hash, newSalt } from './crypto.js';
import { defaultPermissions, require_ } from './permissions.js';
import { lockoutSeconds } from './throttle.js';

let session = null, authAt = 0;
const FRESH_MS = 5 * 60000;
export const currentUser = () => session;
export const hasAdmin = async () => (await q("SELECT 1 FROM users WHERE role='admin' LIMIT 1")).length > 0;

export async function ensureDeviceId() {
  let id = await getSetting('device_id');
  if (!id) { id = uuid(); await setSetting('device_id', id); }
  return id;
}

export async function createAdmin({ fullName, username, password, businessName, phone }) {
  if (!fullName || !username) throw new Error('Name and username are required.');
  if ((password || '').length < 8) throw new Error('Password must be at least 8 characters.');
  if (await hasAdmin()) throw new Error('An admin already exists on this device.');
  const t = now(), deviceId = await ensureDeviceId(), bizId = uuid(), userId = uuid(), salt = newSalt();
  await run('INSERT INTO businesses(id,name,phone,device_id,created_at,updated_at) VALUES(?,?,?,?,?,?)', [bizId, businessName || null, phone || null, deviceId, t, t]);
  await run('INSERT INTO users(id,business_id,full_name,username,role,pw_hash,pw_salt,permissions,device_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
    [userId, bizId, fullName, username.toLowerCase(), 'admin', await hash(password, salt), salt, '{}', deviceId, t, t]);
  await run('INSERT INTO devices(id,business_id,name,device_id,created_at,updated_at) VALUES(?,?,?,?,?,?)', [deviceId, bizId, 'Admin device', deviceId, t, t]);
  await audit(userId, 'admin_created', null, { username });
  return login(username, password);
}

// Wrong passwords slow down: see throttle.js. The message never says whether the username exists.
async function checkThrottle() {
  const wait = Math.ceil((Number((await getSetting('auth_lock_until')) || 0) - Date.now()) / 1000);
  if (wait > 0) throw new Error(`Too many attempts. Try again in ${wait} seconds.`);
}
async function failed() {
  const n = Number((await getSetting('auth_fails')) || 0) + 1;
  await setSetting('auth_fails', n); await setSetting('auth_lock_until', Date.now() + lockoutSeconds(n) * 1000);
  throw new Error('Incorrect username or password.');
}
async function startSession(u, method) {
  session = u; authAt = Date.now();
  await setSetting('auth_fails', 0); await setSetting('auth_lock_until', 0); await setSetting('last_user', u.username);
  await audit(u.id, method === 'password' ? 'login' : 'login_' + method, null, null);
  return u;
}
export async function login(username, password) {
  if ((await getSetting('device_revoked')) === 'true') throw new Error('This device was removed by the admin.');
  await checkThrottle();
  const u = (await q('SELECT * FROM users WHERE username=?', [username.toLowerCase()]))[0];
  if (!u || !u.pw_hash || u.status !== 'active' || (await hash(password, u.pw_salt)) !== u.pw_hash) return failed();
  return startSession(u, 'password');
}
// Used by fingerprint unlock, after the phone has verified the person.
export async function sessionFor(userId, method) {
  if ((await getSetting('device_revoked')) === 'true') throw new Error('This device was removed by the admin.');
  const u = (await q('SELECT * FROM users WHERE id=?', [userId]))[0];
  if (!u || !u.pw_hash || u.status !== 'active') throw new Error('This account cannot sign in on this phone.');
  return startSession(u, method);
}
// Sensitive actions (revoking a device, changing permissions, turning on fingerprint unlock) need a recent password check.
export function requireFreshAuth() {
  if (Date.now() - authAt > FRESH_MS) throw Object.assign(new Error('Enter your password to continue.'), { code: 'REAUTH' });
}
export async function reauthenticate(password) {
  await checkThrottle();
  if (!session || (await hash(password, session.pw_salt)) !== session.pw_hash) return failed();
  await setSetting('auth_fails', 0); authAt = Date.now();
}
export const _ageAuthForTests = (ms) => { authAt = Date.now() - ms; };
export const lock = () => { session = null; };
export const restoreSession = (u) => { session = u; }; // test seam

// Called after the cloud has accepted the pairing code. New linked users start with every
// permission on; the admin can restrict them later.
export async function addLinkedUser({ businessId, businessName, memberId, fullName, username, password }) {
  const t = now(), salt = newSalt(), deviceId = await ensureDeviceId();
  await run('INSERT OR IGNORE INTO businesses(id,name,device_id,sync_status,created_at,updated_at) VALUES(?,?,?,?,?,?)', [businessId, businessName, deviceId, 'SYNCED', t, t]);
  await run('INSERT INTO users(id,business_id,full_name,username,role,pw_hash,pw_salt,permissions,device_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
    [memberId, businessId, fullName, username.toLowerCase(), 'user', await hash(password, salt), salt, JSON.stringify(defaultPermissions()), deviceId, t, t]);
  await run('INSERT OR IGNORE INTO devices(id,business_id,name,device_id,created_at,updated_at) VALUES(?,?,?,?,?,?)', [deviceId, businessId, fullName + "'s device", deviceId, t, t]);
  await audit(memberId, 'device_linked', null, { username });
  return login(username, password);
}
