// Fingerprint / face unlock WITHOUT storing the password. A random unlock token lives in the Android Keystore
// (released only after a successful biometric check); the database keeps just a salted hash of it.
import { getSetting, setSetting, run, audit } from '../db/db.js';
import { currentUser, sessionFor, requireFreshAuth } from './auth.js';
import { hash, newSalt } from './crypto.js';
import { q } from '../db/db.js';

const SERVER = (id) => `com.salestrack.calculator:${id}`;
export const nativeBiometric = {
  async available() { try { const { NativeBiometric } = await import('capacitor-native-biometric'); return (await NativeBiometric.isAvailable()).isAvailable; } catch { return false; } },
  async verify() { const { NativeBiometric } = await import('capacitor-native-biometric'); await NativeBiometric.verifyIdentity({ reason: 'Unlock Sales Track Calculator', title: 'Unlock' }); },
  async setSecret(id, token) { const { NativeBiometric } = await import('capacitor-native-biometric'); await NativeBiometric.setCredentials({ username: id, password: token, server: SERVER(id) }); },
  async getSecret(id) { const { NativeBiometric } = await import('capacitor-native-biometric'); return (await NativeBiometric.getCredentials({ server: SERVER(id) })).password; },
  async deleteSecret(id) { const { NativeBiometric } = await import('capacitor-native-biometric'); await NativeBiometric.deleteCredentials({ server: SERVER(id) }); },
};
let bio = nativeBiometric;
export const setBiometricAdapter = (a) => (bio = a); // test seam

const key = (id) => `bio:${id}`;
export async function biometricReady(username) {
  const u = (await q('SELECT id FROM users WHERE username=?', [username.toLowerCase()]))[0];
  return !!u && !!(await getSetting(key(u.id))) && (await bio.available());
}
export const biometricSupported = () => bio.available();
export const biometricEnabled = async () => !!(await getSetting(key(currentUser().id)));

export async function enableBiometric() {
  const u = currentUser(); requireFreshAuth();
  if (!(await bio.available())) throw new Error('This phone has no fingerprint or face unlock set up.');
  await bio.verify();
  const token = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))), salt = newSalt();
  await bio.setSecret(u.id, token);
  await setSetting(key(u.id), JSON.stringify({ salt, hash: await hash(token, salt) }));
  await audit(u.id, 'biometric_enabled', null, null);
}
export async function disableBiometric() {
  const u = currentUser();
  await run('DELETE FROM settings WHERE key=?', [key(u.id)]);
  try { await bio.deleteSecret(u.id); } catch { /* already gone */ }
  await audit(u.id, 'biometric_disabled', null, null);
}
export async function unlockWithBiometric(username) {
  const u = (await q('SELECT id FROM users WHERE username=?', [username.toLowerCase()]))[0];
  const rec = u && (await getSetting(key(u.id)));
  if (!rec) throw new Error('Fingerprint unlock is not set up. Use your password.');
  await bio.verify();                                            // the phone's own fingerprint / face check
  const { salt, hash: h } = JSON.parse(rec);
  if ((await hash(await bio.getSecret(u.id), salt)) !== h) throw new Error('Fingerprint unlock failed. Use your password.');
  return sessionFor(u.id, 'biometric');                          // same rules as a password login (active user, not revoked)
}
