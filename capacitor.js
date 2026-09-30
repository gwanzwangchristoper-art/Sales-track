import { CapacitorSQLite, SQLiteConnection } from '@capacitor-community/sqlite';
const sqlite = new SQLiteConnection(CapacitorSQLite);
let conn;
// The database is encrypted with a random 256-bit secret generated on first run. The plugin keeps that
// secret in the Android Keystore, so it is never in the app code, never in a backup, and different on every phone.
const randomSecret = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
export const capacitorAdapter = {
  async open() {
    if (!(await sqlite.isSecretStored()).result) await sqlite.setEncryptionSecret(randomSecret());
    conn = await sqlite.createConnection('salestrack', true, 'secret', 1, false);
    await conn.open();
  },
  exec: (sql) => conn.execute(sql),
  query: async (sql, p = []) => (await conn.query(sql, p)).values ?? [],
  run: (sql, p = []) => conn.run(sql, p),
  tx: (statements) => conn.executeSet(statements, true),
};
