// Browser database (used by `npm run dev` and when the app is hosted as a website).
// Same SQLite engine and same migrations as the phone, stored in the browser's IndexedDB via jeep-sqlite.
// NOTE: the browser copy is NOT encrypted (only the Android build is). Use it for trying the app out,
// or on a computer you trust.
import { CapacitorSQLite, SQLiteConnection } from '@capacitor-community/sqlite';
const sqlite = new SQLiteConnection(CapacitorSQLite);
const DB = 'salestrack';
let conn;
const save = () => sqlite.saveToStore(DB);
export const webAdapter = {
  async open() {
    const { defineCustomElements } = await import('jeep-sqlite/loader');
    defineCustomElements(window);
    if (!document.querySelector('jeep-sqlite')) {
      const el = document.createElement('jeep-sqlite'); el.setAttribute('wasmpath', '/assets'); document.body.appendChild(el);
    }
    await customElements.whenDefined('jeep-sqlite');
    await sqlite.initWebStore();
    const consistent = (await sqlite.checkConnectionsConsistency()).result, exists = (await sqlite.isConnection(DB, false)).result;
    conn = consistent && exists ? await sqlite.retrieveConnection(DB, false) : await sqlite.createConnection(DB, false, 'no-encryption', 1, false);
    await conn.open();
  },
  exec: async (sql) => { await conn.execute(sql); await save(); },
  query: async (sql, p = []) => (await conn.query(sql, p)).values ?? [],
  run: async (sql, p = []) => { await conn.run(sql, p, false); await save(); },
  tx: async (statements) => { const r = await conn.executeSet(statements, true); await save(); return r; },
};
