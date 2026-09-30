import { q, run, uuid, now, getSetting } from '../db/db.js';
// One unread notification per (type, reference): repeated events don't pile up.
export async function notify(type, title, body, refId) {
  if ((await q('SELECT 1 FROM notifications WHERE type=? AND ref_id=? AND is_read=0', [type, refId])).length) return;
  const t = now();
  await run('INSERT INTO notifications(id,type,title,body,ref_id,device_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)', [uuid(), type, title, body, refId, await getSetting('device_id'), t, t]);
}
export const unreadCount = async () => (await q('SELECT COUNT(*) n FROM notifications WHERE is_read=0'))[0].n;
export const listNotifications = () => q('SELECT * FROM notifications ORDER BY created_at DESC LIMIT 50');
export const markAllRead = () => run('UPDATE notifications SET is_read=1 WHERE is_read=0');
