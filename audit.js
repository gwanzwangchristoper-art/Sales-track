import { q } from '../db/db.js';
import { currentUser } from '../auth/auth.js';
const adminOnly = () => { if (currentUser()?.role !== 'admin') throw new Error('Admin permission required.'); };

export async function loadAudit({ action = '', date = '', text = '', offset = 0, limit = 30 } = {}) {
  adminOnly();
  const where = [], args = [];
  if (action) { where.push('a.action=?'); args.push(action); }
  if (date) { where.push('a.created_at>=? AND a.created_at<?'); args.push(new Date(date + 'T00:00:00').toISOString(), new Date(new Date(date + 'T00:00:00').getTime() + 864e5).toISOString()); }
  if (text) { where.push("(lower(IFNULL(a.old_value,'')) LIKE ? OR lower(IFNULL(a.new_value,'')) LIKE ? OR lower(IFNULL(a.reason,'')) LIKE ?)"); const l = `%${text.toLowerCase()}%`; args.push(l, l, l); }
  return q(`SELECT a.*, u.full_name who, d.name device_name FROM audit_logs a LEFT JOIN users u ON u.id=a.user_id LEFT JOIN devices d ON d.id=a.device_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY a.created_at DESC LIMIT ? OFFSET ?`, [...args, limit, offset]);
}
export const auditActions = async () => { adminOnly(); return (await q('SELECT DISTINCT action FROM audit_logs ORDER BY action')).map(r => r.action); };
