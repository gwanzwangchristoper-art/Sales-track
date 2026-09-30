// Conflicts are records that SYNC, so the admin sees a conflict raised on any phone, and the admin's decision
// travels back to the phone that holds the disputed edit. Ids are deterministic, so two phones that notice the
// same problem produce one record.
import { q, run, now, getSetting, audit } from '../db/db.js';
import { currentUser } from '../auth/auth.js';
import { notify } from '../notify/notify.js';
import { detId } from './ids.js';
import { META } from './merge.js';

export async function raiseConflict({ key, kind, table = 'products', rowId, field = null, local = null, remote = null, detail = null }) {
  const id = await detId('conflict:' + key), t = now();
  if ((await q('SELECT 1 FROM sync_conflicts WHERE id=?', [id])).length) return null;
  await run(`INSERT INTO sync_conflicts(id,kind,table_name,row_id,field,local_value,remote_value,detail,status,device_id,sync_status,created_at,updated_at,applied)
    VALUES(?,?,?,?,?,?,?,?,'open',?,'SYNC_PENDING',?,?,0)`, [id, kind, table, rowId, field, local, remote, detail, await getSetting('device_id'), t, t]);
  return id;
}

// A resolved field conflict is applied by the phone whose product is stuck in CONFLICT.
// 'local' = keep the value that phone had, 'remote' = take the value already in the cloud.
export async function applyResolutions() {
  for (const c of await q("SELECT * FROM sync_conflicts WHERE status='resolved' AND applied=0 AND kind='field'")) {
    const p = (await q('SELECT id,sync_status FROM products WHERE id=?', [c.row_id]))[0];
    if (p?.sync_status === 'CONFLICT') {
      if (c.resolution === 'remote' && META.includes(c.field)) // whitelist: the field name goes into SQL
        await run(`UPDATE products SET ${c.field}=?, updated_at=? WHERE id=?`, [JSON.parse(c.remote_value), now(), c.row_id]);
    }
    await run('UPDATE sync_conflicts SET applied=1 WHERE id=?', [c.id]);
    if (p && !(await q("SELECT 1 FROM sync_conflicts WHERE kind='field' AND row_id=? AND status='open'", [c.row_id])).length)
      await run("UPDATE products SET sync_status='SYNC_PENDING', updated_at=? WHERE id=? AND sync_status='CONFLICT'", [now(), c.row_id]);
  }
}

export async function resolveConflict(id, choice) {
  const u = currentUser();
  if (u?.role !== 'admin') throw new Error('Admin permission required.');
  const c = (await q("SELECT * FROM sync_conflicts WHERE id=? AND status='open'", [id]))[0];
  if (!c) throw new Error('This item was already resolved.');
  if (c.kind === 'field' ? !['local', 'remote'].includes(choice) : choice !== 'acknowledge') throw new Error('Choose how to resolve this.');
  const t = now();
  await run("UPDATE sync_conflicts SET status='resolved', resolution=?, resolved_by=?, resolved_at=?, updated_at=?, sync_status='SYNC_PENDING', applied=0 WHERE id=?", [choice, u.id, t, t, id]);
  await applyResolutions();
  await audit(u.id, 'conflict_resolved', { kind: c.kind, field: c.field, local: c.local_value, remote: c.remote_value }, { choice });
}

// Two phones corrected the same sale offline: the stock reversal collapses to one row, but there are now two replacements.
export async function checkDuplicateCorrections() {
  const dups = await q("SELECT corrects_sale_id o, GROUP_CONCAT(id) ids FROM sales WHERE corrects_sale_id IS NOT NULL AND status='confirmed' GROUP BY corrects_sale_id HAVING COUNT(*)>1");
  for (const d of dups)
    if (await raiseConflict({ key: 'dup:' + d.o, kind: 'duplicate_correction', table: 'sales', rowId: d.o, detail: JSON.stringify({ sales: d.ids.split(',') }) }))
      await notify('sync_conflict', 'Sync conflict', 'One sale was corrected on two devices. Admin review needed.', d.o);
}

export const listOpenConflicts = () => q(`SELECT c.*, p.name product_name, d.name device_name FROM sync_conflicts c
  LEFT JOIN products p ON p.id=c.row_id LEFT JOIN devices d ON d.id=c.device_id WHERE c.status='open' ORDER BY c.created_at`);
