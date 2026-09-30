// Storage-agnostic core. The real phone uses db/capacitor.js; tests plug in an in-memory SQLite.
// adapter = { open(), exec(sql), query(sql, params) -> rows, run(sql, params), tx(statements) }
import { MIGRATIONS } from './schema.js';
let adapter, onWrite = () => {};
export const setAdapter = (a) => (adapter = a);
export const setOnWrite = (f) => (onWrite = f);
export const uuid = () => crypto.randomUUID();
export const now = () => new Date().toISOString();

export async function openDb() { await adapter.open(); await migrate(); }
async function migrate() {
  await adapter.exec('CREATE TABLE IF NOT EXISTS schema_version(version INTEGER PRIMARY KEY);');
  const cur = (await adapter.query('SELECT MAX(version) v FROM schema_version'))[0]?.v ?? 0;
  for (const m of MIGRATIONS.filter(m => m.version > cur)) {
    await adapter.exec(m.sql);
    await adapter.run('INSERT INTO schema_version(version) VALUES(?)', [m.version]);
  }
}
export const q = (sql, p = []) => adapter.query(sql, p);
export const run = (sql, p = []) => adapter.run(sql, p);
// Atomic multi-statement write. Also nudges the sync engine so new records upload soon.
export const tx = async (statements) => { const r = await adapter.tx(statements); onWrite(); return r; };
export const txQuiet = (statements) => adapter.tx(statements); // for the sync engine's own bookkeeping
export async function getSetting(k) { return (await q('SELECT value FROM settings WHERE key=?', [k]))[0]?.value; }
export async function setSetting(k, v) { await run('INSERT OR REPLACE INTO settings(key,value,updated_at) VALUES(?,?,?)', [k, String(v), now()]); }
export async function audit(userId, action, oldV, newV, reason = null) {
  const t = now();
  await run('INSERT INTO audit_logs(id,user_id,action,old_value,new_value,reason,device_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)',
    [uuid(), userId, action, JSON.stringify(oldV ?? null), JSON.stringify(newV ?? null), reason, await getSetting('device_id'), t, t]);
}
