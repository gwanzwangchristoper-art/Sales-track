// PURE: turns a raw audit row into a sentence a shop owner can read.
export const ACTION_GROUPS = {
  sales: ['sale_confirmed', 'sale_corrected', 'sale_voided'],
  stock: ['stock_adjusted', 'invoice_confirmed'],
  products: ['product_created', 'product_edited'],
  access: ['login', 'admin_created', 'device_linked', 'device_revoked', 'permission_changed', 'pairing_code_created', 'cloud_connected', 'setting_changed'],
  sync: ['conflict_resolved', 'rejected_retried'],
};
const money = (n) => '₦' + Number(n).toLocaleString('en-NG', { maximumFractionDigits: 2 });
const parse = (s) => { try { return JSON.parse(s) ?? {}; } catch { return {}; } };
const items = (list) => (list || []).map(i => `${i.name} × ${i.quantity} at ${money(i.unit_price)}`).join(', ');

export function describeAudit(row) {
  const o = parse(row.old_value), n = parse(row.new_value), why = row.reason ? ` Reason: ${row.reason}.` : '';
  switch (row.action) {
    case 'sale_confirmed': return { title: 'Sale confirmed', detail: `${n.receipt}, total ${money(n.total)}` };
    case 'sale_corrected': return { title: 'Sale corrected', detail: `${o.receipt} (${items(o.items)}, ${money(o.total)}) became ${n.corrected_to} (${items(n.items)}, ${money(n.total)}).${why}` };
    case 'sale_voided': return { title: 'Sale voided', detail: `${o.receipt} for ${money(o.total)} was cancelled and its stock returned.${why}` };
    case 'stock_adjusted': return { title: 'Stock adjusted', detail: `Quantity ${o.quantity} → ${n.quantity} (${n.delta > 0 ? '+' : ''}${n.delta}).${why}` };
    case 'invoice_confirmed': return { title: 'Invoice added to stock', detail: `${n.invoice ? 'Invoice ' + n.invoice : 'Invoice'}${n.supplier ? ' from ' + n.supplier : ''}: ${n.items} item(s), ${money(n.total)}` };
    case 'product_created': return { title: 'Product created', detail: n.name || '' };
    case 'product_edited': {
      const ch = Object.keys(n).filter(k => JSON.stringify(n[k]) !== JSON.stringify(o[k])).map(k => `${k.replace(/_/g, ' ')}: ${o[k] ?? 'none'} → ${n[k] ?? 'none'}`);
      return { title: 'Product edited', detail: ch.join('; ') || 'No visible change' };
    }
    case 'permission_changed': { const k = Object.keys(n)[0]; return { title: 'Permission changed', detail: `${(k || '').replace(/_/g, ' ')}: ${o[k] ? 'allowed' : 'restricted'} → ${n[k] ? 'allowed' : 'restricted'}` }; }
    case 'conflict_resolved': return { title: 'Sync conflict resolved', detail: `${(o.field || 'stock').replace(/_/g, ' ')}: kept ${n.choice === 'theirs' ? 'the other device’s value' : n.choice === 'mine' ? 'this device’s value' : 'as is (acknowledged)'}` };
    case 'setting_changed': return { title: 'Setting changed', detail: `${Object.keys(n)[0]?.replace(/_/g, ' ')}: ${Object.values(o)[0]} → ${Object.values(n)[0]}` };
    case 'device_revoked': return { title: 'Device revoked', detail: '' };
    case 'login': return { title: 'Signed in', detail: '' };
    default: return { title: row.action.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase()), detail: why.trim() };
  }
}
