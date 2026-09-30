// Default-allow model: new users get everything except the admin-only set.
export const ALL = ['calculate','sell','view_history','edit_products','adjust_stock','scan_invoices',
  'view_analysis','export','change_settings','corrections','link_devices'];
export const ADMIN_ONLY = ['manage_users','revoke_devices','edit_permissions']; // audit log is append-only for everyone
export const defaultPermissions = () => Object.fromEntries(ALL.map(p => [p, true]));

export function can(user, perm) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  if (ADMIN_ONLY.includes(perm)) return false;
  return JSON.parse(user.permissions || '{}')[perm] !== false; // only an explicit false restricts
}
export function require_(user, perm) {
  if (!can(user, perm)) throw new Error('Admin permission required.');
}
