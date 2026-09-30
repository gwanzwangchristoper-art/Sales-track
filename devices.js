import { q, run, uuid, now, audit, getSetting, setSetting } from '../db/db.js';
import { currentUser, ensureDeviceId, addLinkedUser, hasAdmin, requireFreshAuth } from '../auth/auth.js';
import { require_ } from '../auth/permissions.js';
import { pairingCode, normalizeCode } from '../auth/crypto.js';
import { getClient, rpc, cloudConfigured } from './client.js';

export const cloudEnabled = async () => (await getSetting('cloud_enabled')) === 'true';
export { cloudConfigured };

// Cloud is opt-in and happens AFTER local setup, so the app is fully usable offline from the first minute.
// The local business/user/device ids are reused in the cloud so both sides agree on identity.
export async function connectAdmin({ email, password }) {
  const u = currentUser(); require_(u, 'manage_users');
  if (!email || (password || '').length < 8) throw new Error('Enter your email and a password of 8+ characters.');
  const c = getClient();
  let { data, error } = await c.auth.signInWithPassword({ email, password });
  if (error) ({ data, error } = await c.auth.signUp({ email, password }));
  if (error) throw new Error(error.message);
  if (!data.session) throw new Error('Check your email to confirm the account, then tap Connect again.');
  const biz = (await q('SELECT * FROM businesses WHERE id=?', [u.business_id]))[0], dev = await ensureDeviceId();
  await rpc('create_business', { p_business_id: u.business_id, p_name: biz.name, p_phone: biz.phone, p_member_id: u.id, p_full_name: u.full_name,
    p_username: u.username, p_device_id: dev, p_device_name: 'Admin device' });
  await setSetting('cloud_enabled', 'true');
  await audit(u.id, 'cloud_connected', null, { email });
}

export async function createPairing() {
  const u = currentUser(); require_(u, 'link_devices');
  const code = pairingCode();
  await rpc('create_pairing_code', { p_business_id: u.business_id, p_code: code });
  await audit(u.id, 'pairing_code_created', null, null);
  return code;
}

// Runs on the NEW device. The cloud validates the code; only then is the local account created.
export async function linkDevice({ code, fullName, username, password }) {
  if (!fullName || !username) throw new Error('Enter your name and a username.');
  if ((password || '').length < 8) throw new Error('Password must be at least 8 characters.');
  if (await hasAdmin() || (await q('SELECT 1 FROM users LIMIT 1')).length) throw new Error('This device already has an account.');
  const c = getClient(), { error } = await c.auth.signInAnonymously();
  if (error) throw new Error('Could not reach the cloud. Check your internet and try again.');
  const memberId = uuid();
  try {
    const r = await rpc('redeem_pairing_code', { p_code: normalizeCode(code), p_member_id: memberId, p_full_name: fullName, p_username: username,
      p_device_id: await ensureDeviceId(), p_device_name: `${fullName}'s device` });
    await setSetting('cloud_enabled', 'true');
    return addLinkedUser({ businessId: r.business_id, businessName: r.business_name, memberId, fullName, username, password });
  } catch (e) { await c.auth.signOut(); throw e; }
}

// Pulls device and user status from the cloud into the local tables (best effort; offline just shows the last known state).
export async function refreshDevices() {
  if (await cloudEnabled() && cloudConfigured()) {
    try {
      const c = getClient(), [d, m] = await Promise.all([c.from('devices').select('*'), c.from('members').select('*')]);
      if (d.error || m.error) throw new Error('offline');
      const t = now(), dev = await getSetting('device_id');
      for (const x of d.data) await run(`INSERT INTO devices(id,business_id,name,status,last_sync,device_id,sync_status,created_at,updated_at) VALUES(?,?,?,?,?,?,'SYNCED',?,?)
        ON CONFLICT(id) DO UPDATE SET name=excluded.name,status=excluded.status,last_sync=excluded.last_sync,updated_at=excluded.updated_at`, [x.id, x.business_id, x.name, x.status, x.last_sync, dev, t, t]);
      for (const x of m.data) await run(`INSERT INTO users(id,business_id,full_name,username,role,permissions,status,device_id,sync_status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,'SYNCED',?,?)
        ON CONFLICT(id) DO UPDATE SET status=excluded.status,permissions=excluded.permissions,full_name=excluded.full_name,updated_at=excluded.updated_at`,
        [x.id, x.business_id, x.full_name, x.username, x.role, JSON.stringify(x.permissions || {}), x.status, dev, t, t]);
    } catch { /* offline: fall through to local data */ }
  }
  return q('SELECT * FROM devices ORDER BY created_at');
}
export const listUsers = () => q("SELECT * FROM users WHERE role='user' ORDER BY full_name");

export async function revokeDevice(deviceId) {
  const u = currentUser(); require_(u, 'revoke_devices'); requireFreshAuth();
  await rpc('revoke_device', { p_device_id: deviceId });
  await run("UPDATE devices SET status='revoked', updated_at=? WHERE id=?", [now(), deviceId]);
  await audit(u.id, 'device_revoked', { status: 'active' }, { status: 'revoked', device: deviceId });
}

// Permission changes are enforced by the cloud, so they need a connection.
export async function setPermission(memberId, perm, allowed) {
  const u = currentUser(); require_(u, 'edit_permissions'); requireFreshAuth();
  await rpc('set_permission', { p_member_id: memberId, p_perm: perm, p_allowed: allowed });
  const row = (await q('SELECT permissions FROM users WHERE id=?', [memberId]))[0], p = JSON.parse(row?.permissions || '{}');
  await run('UPDATE users SET permissions=?, updated_at=? WHERE id=?', [JSON.stringify({ ...p, [perm]: allowed }), now(), memberId]);
  await audit(u.id, 'permission_changed', { [perm]: p[perm] !== false }, { [perm]: allowed }, null);
}

// Also tells this device whether the admin revoked it. Revoked devices can't unlock or sync; local data is kept
// (never silently deleted) so any unsynced sales can be reviewed by the admin.
export async function heartbeat() {
  if (!(await cloudEnabled()) || !cloudConfigured()) return null;
  try {
    const s = await rpc('device_heartbeat', { p_device_id: await ensureDeviceId() });
    if (s === 'revoked') await setSetting('device_revoked', 'true');
    return s;
  } catch { return null; }
}
