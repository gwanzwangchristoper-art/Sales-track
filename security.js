import { getSetting, setSetting, audit } from '../db/db.js';
import { currentUser } from './auth.js';
import { require_ } from './permissions.js';
export const AUTO_LOCK_CHOICES = [1, 2, 5, 10, 30];
export const getAutoLockMinutes = async () => Number((await getSetting('auto_lock_minutes')) ?? 2);
export async function setAutoLockMinutes(m) {
  const u = currentUser(); require_(u, 'change_settings');
  if (!AUTO_LOCK_CHOICES.includes(Number(m))) throw new Error('Choose one of the listed times.');
  const old = await getAutoLockMinutes();
  await setSetting('auto_lock_minutes', Number(m));
  await audit(u.id, 'setting_changed', { auto_lock_minutes: old }, { auto_lock_minutes: Number(m) });
}
