// SYNC ENGINE. Local SQLite is always the source the UI reads. Rows written offline are marked
// SYNC_PENDING; a run does PULL first (so merges see the other devices' work) then PUSH.
// A row is marked SYNCED only after the cloud confirms it. A failed run never deletes anything: it retries later.
import { q, run, txQuiet as tx, now, uuid, getSetting, setSetting, setOnWrite, audit } from '../db/db.js';
import { currentUser } from '../auth/auth.js';
import { getClient, cloudConfigured } from '../cloud/client.js';
import { cloudEnabled, heartbeat } from '../cloud/devices.js';
import { notify } from '../domain/notify.js';
import { effectiveItems } from '../domain/corrections.js';
import { TABLES, META, pick, toCloudRow, fromCloudRow, planProductPull, mergeStatus } from './merge.js';

const PAGE = 500, OVERLAP_MS = 10000;
let running = false, timer = null, nudge = null;
const touchedProducts = new Set(), touchedSales = new Set();

export function startSync() {
  setOnWrite(() => { clearTimeout(nudge); nudge = setTimeout(syncNow, 2500); }); // soon after any saved change
  timer ||= setInterval(syncNow, 30000);
  window.addEventListener('online', syncNow);
  setTimeout(syncNow, 2000);
}

export async function syncNow() {
  if (running) return { skipped: true };
  running = true;
  try {
    if (!cloudConfigured() || !(await cloudEnabled())) return { skipped: true };
    await heartbeat();
    if ((await getSetting('device_revoked')) === 'true') return { revoked: true }; // revoked devices never sync; local data is kept
    const biz = (await q('SELECT id FROM businesses LIMIT 1'))[0]?.id;
    if (!biz) return { skipped: true };
    touchedProducts.clear(); touchedSales.clear();
    await pull();
    await checkNegativeStock();
    await checkCorrectionOverlaps();
    await push(biz);
    await setSetting('last_sync_at', now()); await setSetting('last_sync_error', '');
    return { ok: true };
  } catch (e) {
    await setSetting('last_sync_error', navigator.onLine === false ? 'Offline. Changes are saved and will upload when you are back online.' : `Sync failed: ${e.message}. Will retry.`);
    return { error: e.message };
  } finally { running = false; }
}

// ---------------- PULL ----------------
async function pull() {
  const c = getClient();
  for (const T of TABLES) {
    const saved = await getSetting('cursor:' + T.name);
    let since = new Date((saved ? new Date(saved).getTime() : 0) - OVERLAP_MS).toISOString(), latest = null;
    for (;;) {
      const { data, error } = await c.from(T.name).select('*').gt('synced_at', since).order('synced_at').order('id').limit(PAGE);
      if (error) throw new Error(error.message);
      for (const r of data) await applyRemote(T, r);
      if (data.length) since = latest = data[data.length - 1].synced_at; // keyset paging inside one run
      if (data.length < PAGE) break;
    }
    if (latest) await setSetting('cursor:' + T.name, latest);
  }
}

const insertSql = (T) => `INSERT OR IGNORE INTO ${T.name}(id,${T.cols.join(',')},device_id,sync_status,created_at,updated_at) VALUES(?,${T.cols.map(() => '?').join(',')},?,'SYNCED',?,?)`;
const insertVals = (T, r) => [r.id, ...T.cols.map(k => r[k] ?? null), r.device_id ?? null, r.created_at, r.updated_at];

async function applyRemote(T, raw) {
  const r = fromCloudRow(raw);
  const local = (await q(`SELECT * FROM ${T.name} WHERE id=?`, [r.id]))[0];
  switch (T.kind) {
    case 'append':
      if (!local) { await tx([{ statement: insertSql(T), values: insertVals(T, r) }]); if (T.name === 'audit_logs') await auditNotice(r); }
      break;
    case 'lww':
      if (!local) await tx([{ statement: insertSql(T), values: insertVals(T, r) }]);
      else if (local.sync_status === 'SYNCED' && r.updated_at > local.updated_at)
        await tx([{ statement: `UPDATE categories SET name=?, updated_at=? WHERE id=?`, values: [r.name, r.updated_at, r.id] }]);
      break;
    case 'status': { if (r.corrects_sale_id) touchedSales.add(r.corrects_sale_id);
      // status only moves forward, so a late "calculated" can never undo a "confirmed"
      if (!local) return tx([{ statement: insertSql(T), values: insertVals(T, r) }]);
      const s = mergeStatus(local.status, r.status);
      if (s !== local.status) await tx([{ statement: `UPDATE sales SET status=?, sync_status='SYNCED', updated_at=? WHERE id=?`, values: [s, r.updated_at, r.id] }]);
      break; }
    case 'ledger': // add the other device's stock event; skip if we already have it (our own rows come back too)
      if (local) return;
      await tx([{ statement: insertSql(T), values: insertVals(T, r) }, { statement: 'UPDATE products SET quantity=quantity+? WHERE id=?', values: [r.delta, r.product_id] }]);
      touchedProducts.add(r.product_id);
      break;
    case 'versioned': await applyProduct(r, local); break;
  }
}

async function applyProduct(r, local) {
  const plan = planProductPull(local, r);
  if (plan.action === 'skip') return;
  const m = plan.meta, base = JSON.stringify(plan.remoteMeta || m), t = now();
  if (plan.action === 'insert')
    return tx([{ statement: `INSERT OR IGNORE INTO products(id,${META.join(',')},quantity,device_id,sync_status,created_at,updated_at,base_version,base_json) VALUES(?,${META.map(() => '?').join(',')},0,?,'SYNCED',?,?,?,?)`,
      values: [r.id, ...META.map(k => m[k]), r.device_id ?? null, r.created_at, r.updated_at, r.version, base] }]);
  const status = { take: 'SYNCED', merge: 'SYNC_PENDING', conflict: 'CONFLICT' }[plan.action];
  await tx([{ statement: `UPDATE products SET ${META.map(k => k + '=?').join(',')}, sync_status=?, base_version=?, base_json=?, updated_at=? WHERE id=?`,
    values: [...META.map(k => m[k]), status, r.version, base, plan.action === 'take' ? r.updated_at : t, r.id] }]);
  if (plan.action === 'conflict') {
    for (const c of plan.conflicts)
      await run('INSERT INTO sync_conflicts(id,kind,table_name,row_id,field,local_value,remote_value,status,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
        [uuid(), 'field', 'products', r.id, c.field, JSON.stringify(c.local), JSON.stringify(c.remote), 'open', t]);
    await notify('sync_conflict', 'Sync conflict', `${m.name}: two devices changed the same detail. Admin review needed.`, r.id);
  }
}

// After combining devices, stock can go below zero even though each device checked its own stock.
// We keep every stock event (nothing is dropped) and raise a conflict for the admin instead of blocking history.
async function checkNegativeStock() {
  if ((await getSetting('negative_stock')) === 'true') return;
  for (const id of touchedProducts) {
    const p = (await q('SELECT id,name,quantity FROM products WHERE id=?', [id]))[0];
    if (!p || p.quantity >= 0) continue;
    if ((await q("SELECT 1 FROM sync_conflicts WHERE kind='negative_stock' AND row_id=? AND status='open'", [id])).length) continue;
    const recent = await q('SELECT delta,reason,device_id,created_at FROM inventory_transactions WHERE product_id=? ORDER BY created_at DESC LIMIT 10', [id]);
    await run('INSERT INTO sync_conflicts(id,kind,table_name,row_id,field,local_value,detail,status,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
      [uuid(), 'negative_stock', 'products', id, 'quantity', String(p.quantity), JSON.stringify(recent), 'open', now()]);
    await notify('sync_conflict', 'Sync conflict', `${p.name} is at ${p.quantity} after combining devices. Review needed.`, id);
  }
}

// Two devices can each correct the same sale offline. Both corrections are kept, but if together they undo
// MORE than was sold (quantity below zero) the admin is told, rather than the numbers being quietly wrong.
async function checkCorrectionOverlaps() {
  for (const id of touchedSales) {
    if (!(await effectiveItems(id)).some(i => i.quantity < 0)) continue;
    if ((await q("SELECT 1 FROM sync_conflicts WHERE kind='correction_overlap' AND row_id=? AND status='open'", [id])).length) continue;
    await run('INSERT INTO sync_conflicts(id,kind,table_name,row_id,status,created_at) VALUES(?,?,?,?,?,?)', [uuid(), 'correction_overlap', 'sales', id, 'open', now()]);
    await notify('sync_conflict', 'Sync conflict', 'A sale was corrected on two devices and the corrections overlap. Review needed.', id);
  }
}
const AUDIT_NOTES = { sale_corrected: ['audit_correction', 'Sale corrected'], device_linked: ['device_linked', 'New device linked'], device_revoked: ['device_revoked', 'Device revoked'] };
async function auditNotice(r) { // the admin hears about other devices' important actions
  const n = AUDIT_NOTES[r.action];
  if (!n || r.device_id === (await getSetting('device_id'))) return;
  let v = {}; try { v = JSON.parse(r.new_value) || {}; } catch { /* ignore */ }
  await notify(n[0], n[1], r.action === 'sale_corrected' ? `${v.receipt || 'A sale'}${r.reason ? ': ' + r.reason : ''}` : (v.username || 'Change made on another device'), r.id);
}
export async function retryRejected() {
  const u = currentUser(); if (u?.role !== 'admin') throw new Error('Admin permission required.');
  for (const T of TABLES) await run(`UPDATE ${T.name} SET sync_status='SYNC_PENDING' WHERE sync_status='REJECTED'`);
}

// ---------------- PUSH ----------------
async function push(biz) {
  for (const T of TABLES) for (;;) {
    const rows = await q(`SELECT * FROM ${T.name} WHERE sync_status='SYNC_PENDING' ORDER BY created_at LIMIT 100`);
    if (!rows.length) break;
    const progressed = T.kind === 'versioned' ? await pushProducts(T, rows, biz) : await pushBatch(T, rows, biz);
    if (!progressed) break; // nothing moved (for example a version race): the next run's pull resolves it
  }
}

const markSynced = (T, rows) => tx(rows.map(r => ({ statement: `UPDATE ${T.name} SET sync_status='SYNCED' WHERE id=? AND updated_at=?`, values: [r.id, r.updated_at] }))); // only if not edited meanwhile
async function reject(T, r) {
  await run(`UPDATE ${T.name} SET sync_status='REJECTED' WHERE id=?`, [r.id]);
  await notify('sync_rejected', 'Sync refused', 'The cloud refused some changes from this device. Ask the admin to review.', r.id);
}
const isDenied = (e) => e.code === '42501' || e.status === 403;

async function pushBatch(T, rows, biz) {
  const c = getClient(), ignore = T.kind === 'append' || T.kind === 'ledger', up = (rs) => c.from(T.name).upsert(rs.map(r => toCloudRow(T, r, biz)), { onConflict: 'id', ignoreDuplicates: ignore });
  const { error } = await up(rows);
  if (!error) { await markSynced(T, rows); return rows.length; }
  if (!isDenied(error)) throw new Error(error.message);
  for (const r of rows) { // one refused row must not block the others: retry one by one
    const { error: e } = await up([r]);
    if (!e) await markSynced(T, [r]); else if (isDenied(e)) await reject(T, r); else throw new Error(e.message);
  }
  return rows.length;
}

// Products use optimistic concurrency: the update only applies if the cloud version is still the one we last saw.
async function pushProducts(T, rows, biz) {
  const c = getClient(); let n = 0;
  for (const r of rows) {
    if (r.base_version === 0) { // never uploaded
      const { data, error } = await c.from('products').insert(toCloudRow(T, r, biz)).select('version').single();
      if (!error) { await finishProduct(r, data.version); n++; }
      else if (isDenied(error)) { await reject(T, r); n++; }
      else if (error.code !== '23505') throw new Error(error.message); // 23505 = already there from an earlier attempt: next pull rebases it
      continue;
    }
    const { data, error } = await c.from('products').update({ ...pick(r, META), device_id: r.device_id ?? null, updated_at: r.updated_at }).eq('id', r.id).eq('version', r.base_version).select('version');
    if (error) { if (isDenied(error)) { await reject(T, r); n++; continue; } throw new Error(error.message); }
    if (data.length) { await finishProduct(r, data[0].version); n++; }
  }
  return n;
}
const finishProduct = (r, version) => run(`UPDATE products SET base_version=?, base_json=?, sync_status=CASE WHEN updated_at=? THEN 'SYNCED' ELSE sync_status END WHERE id=?`, [version, JSON.stringify(pick(r, META)), r.updated_at, r.id]);

// ---------------- Admin: resolve conflicts ----------------
// field conflict: 'mine' keeps this device's value (it uploads next run); 'theirs' takes the other device's value.
// negative stock: 'acknowledge' records that the admin has seen it (fix the stock with Add stock or a correction).
export async function resolveConflict(id, choice) {
  const u = currentUser();
  if (u?.role !== 'admin') throw new Error('Admin permission required.');
  const c = (await q('SELECT * FROM sync_conflicts WHERE id=? AND status=\'open\'', [id]))[0];
  if (!c) throw new Error('This item was already resolved.');
  const t = now();
  if (c.kind === 'field' && !META.includes(c.field)) throw new Error('Unknown field.');
  if (c.kind === 'field' && choice === 'theirs')
    await run(`UPDATE products SET ${c.field}=?, updated_at=? WHERE id=?`, [JSON.parse(c.remote_value), t, c.row_id]);
  await run("UPDATE sync_conflicts SET status='resolved', resolution=?, resolved_by=?, resolved_at=? WHERE id=?", [choice, u.id, t, id]);
  if (c.kind === 'field' && !(await q("SELECT 1 FROM sync_conflicts WHERE kind='field' AND row_id=? AND status='open'", [c.row_id])).length)
    await run("UPDATE products SET sync_status='SYNC_PENDING', updated_at=? WHERE id=?", [t, c.row_id]);
  await audit(u.id, 'conflict_resolved', { field: c.field, local: c.local_value, remote: c.remote_value }, { choice }, null);
}

export async function syncStatus() {
  let pending = 0, rejected = 0;
  for (const T of TABLES) {
    pending += (await q(`SELECT COUNT(*) n FROM ${T.name} WHERE sync_status='SYNC_PENDING'`))[0].n;
    rejected += (await q(`SELECT COUNT(*) n FROM ${T.name} WHERE sync_status='REJECTED'`))[0].n;
  }
  return { pending, rejected, conflicts: (await q("SELECT COUNT(*) n FROM sync_conflicts WHERE status='open'"))[0].n,
    last: await getSetting('last_sync_at'), error: await getSetting('last_sync_error') };
}

export async function listConflicts() {
  return q(`SELECT c.*, p.name product_name FROM sync_conflicts c LEFT JOIN products p ON p.id=c.row_id WHERE c.status='open' ORDER BY c.created_at`);
}
// Rows the cloud refused (for example a permission was missing at the time). After the admin fixes access, put them back in the queue. Nothing is deleted.
export async function retryRejected() {
  const u = currentUser();
  if (u?.role !== 'admin') throw new Error('Admin permission required.');
  let n = 0;
  for (const T of TABLES) { n += (await q(`SELECT COUNT(*) n FROM ${T.name} WHERE sync_status='REJECTED'`))[0].n; await run(`UPDATE ${T.name} SET sync_status='SYNC_PENDING' WHERE sync_status='REJECTED'`); }
  await audit(u.id, 'rejected_retried', null, { rows: n });
  return n;
}
