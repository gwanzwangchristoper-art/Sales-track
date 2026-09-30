import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { setAdapter, openDb, q, run, setSetting, getSetting } from '../src/db/db.js';
import { lockoutSeconds, shouldLock } from '../src/auth/throttle.js';
const mem = new DatabaseSync(':memory:');
setAdapter({ async open() {}, async exec(s) { mem.exec(s); }, async query(s, p = []) { return mem.prepare(s).all(...p); }, async run(s, p = []) { mem.prepare(s).run(...p); },
  async tx(st) { mem.exec('BEGIN'); try { for (const x of st) mem.prepare(x.statement).run(...x.values); mem.exec('COMMIT'); } catch (e) { mem.exec('ROLLBACK'); throw e; } } });
const auth = await import('../src/auth/auth.js');
const bio = await import('../src/auth/biometric.js');
const sec = await import('../src/auth/security.js');
const { revokeDevice } = await import('../src/cloud/devices.js');
const { saveTransaction } = await import('../src/domain/sales.js');
const { addProduct } = await import('../src/domain/products.js');
const { confirmSale } = await import('../src/domain/inventory.js');
const { correctSale } = await import('../src/domain/corrections.js');

test('lockout schedule and idle-lock rule', () => {
  assert.deepEqual([1, 4, 5, 6, 7, 20].map(lockoutSeconds), [0, 0, 30, 60, 120, 900]);
  assert.equal(shouldLock(0, 119000, 2), false); assert.equal(shouldLock(0, 120000, 2), true); assert.equal(shouldLock(0, 9e9, 0), false);
});
test('setup', async () => {
  await openDb(); await auth.createAdmin({ fullName: 'Chris', username: 'chris', password: 'password123' });
});
test('five wrong passwords lock sign-in, even for the right password, then it recovers', async () => {
  auth.lock();
  for (let i = 0; i < 5; i++) await assert.rejects(() => auth.login('chris', 'wrong' + i), /Incorrect username or password/);
  await assert.rejects(() => auth.login('chris', 'password123'), /Too many attempts. Try again in \d+ seconds/);
  await assert.rejects(() => auth.login('nobody', 'x'), /Too many attempts/);                    // same answer for unknown users
  await setSetting('auth_lock_until', Date.now() - 1);                                             // time passes
  await auth.login('chris', 'password123');
  assert.equal(await getSetting('auth_fails'), '0');
  await assert.rejects(() => auth.login('nobody', 'x'), /Incorrect username or password/);         // failures look identical for wrong user and wrong password
});
test('sensitive actions need a recent password; a wrong password does not count', async () => {
  const s = await saveTransaction([]).catch(() => null);                                          // (no lines: refused, irrelevant)
  auth._ageAuthForTests(6 * 60000);
  await assert.rejects(() => revokeDevice('x'), (e) => e.code === 'REAUTH');
  await assert.rejects(() => bio.enableBiometric(), (e) => e.code === 'REAUTH');
  await assert.rejects(() => auth.reauthenticate('nope'), /Incorrect/);
  await assert.rejects(() => revokeDevice('x'), (e) => e.code === 'REAUTH');
  await auth.reauthenticate('password123');
  await assert.rejects(() => revokeDevice('x'), (e) => e.code !== 'REAUTH');                       // now passes the check (fails later: no cloud in this test)
});
test('fingerprint unlock: no password stored, wrong token refused, revoked user refused, can be turned off', async () => {
  const vault = new Map(); let verifyOk = true;
  bio.setBiometricAdapter({ available: async () => true, verify: async () => { if (!verifyOk) throw new Error('cancelled'); },
    setSecret: async (id, t) => vault.set(id, t), getSecret: async (id) => vault.get(id), deleteSecret: async (id) => vault.delete(id) });
  await bio.enableBiometric();
  const me = auth.currentUser(), stored = await getSetting('bio:' + me.id);
  assert.ok(stored && !stored.includes('password123') && !stored.includes(vault.get(me.id)));   // database holds only a salted hash of the token
  assert.equal(await bio.biometricReady('CHRIS'), true);
  auth.lock(); assert.equal(auth.currentUser(), null);
  assert.equal((await bio.unlockWithBiometric('chris')).username, 'chris');
  auth.lock(); verifyOk = false; await assert.rejects(() => bio.unlockWithBiometric('chris'), /cancelled/); assert.equal(auth.currentUser(), null);
  verifyOk = true; vault.set(me.id, 'tampered'); await assert.rejects(() => bio.unlockWithBiometric('chris'), /failed/);
  await assert.rejects(() => bio.unlockWithBiometric('nobody'), /not set up/);
  vault.set(me.id, [...vault.values()][0]);
  await auth.login('chris', 'password123'); await bio.disableBiometric();
  assert.equal(await bio.biometricReady('chris'), false); assert.equal(vault.size, 0);
});
test('a revoked or disabled user cannot sign in with a fingerprint either', async () => {
  const vault = new Map();
  bio.setBiometricAdapter({ available: async () => true, verify: async () => {}, setSecret: async (id, t) => vault.set(id, t), getSecret: async (id) => vault.get(id), deleteSecret: async (id) => vault.delete(id) });
  await auth.addLinkedUser({ businessId: (await q('SELECT id FROM businesses'))[0].id, businessName: 'x', memberId: crypto.randomUUID(), fullName: 'Bob', username: 'bob', password: 'password123' });
  await bio.enableBiometric(); auth.lock();
  await run("UPDATE users SET status='revoked' WHERE username='bob'");
  await assert.rejects(() => bio.unlockWithBiometric('bob'), /cannot sign in/);
  await run("UPDATE users SET status='active' WHERE username='bob'"); await setSetting('device_revoked', 'true');
  await assert.rejects(() => bio.unlockWithBiometric('bob'), /removed by the admin/);
  await setSetting('device_revoked', 'false');
});
test('only people allowed to change settings can change the auto-lock time', async () => {
  await auth.login('bob', 'password123'); await run("UPDATE users SET permissions=? WHERE username='bob'", [JSON.stringify({ change_settings: false })]); await auth.login('bob', 'password123');
  await assert.rejects(() => sec.setAutoLockMinutes(5), /Admin permission required/);
  await auth.login('chris', 'password123');
  await assert.rejects(() => sec.setAutoLockMinutes(0), /Choose one/);
  await sec.setAutoLockMinutes(5); assert.equal(await sec.getAutoLockMinutes(), 5);
  assert.equal((await q("SELECT COUNT(*) n FROM audit_logs WHERE action='setting_changed'"))[0].n, 1);
});
test('receipt numbers carry the phone id, so two phones cannot print the same one', async () => {
  const p = await addProduct({ name: 'Cola', sellPrice: '500', quantity: '10' });
  const a = await saveTransaction([{ productId: p.id, name: 'Cola', quantity: 1, price: 500 }]);
  const dev = (await getSetting('device_id')).replace(/-/g, '').slice(0, 4).toUpperCase();
  assert.equal(a.receipt, `STC-${dev}-000001`);
  await confirmSale(a.saleId);
  const c = await correctSale(a.saleId, { lines: [{ productId: p.id, name: 'Cola', quantity: 2, price: 500 }], reason: 'two cans' });
  assert.equal(c.receipt, `STC-${dev}-000002`);
  await run("UPDATE settings SET value='ffff-other-phone' WHERE key='device_id'");
  assert.notEqual((await saveTransaction([{ productId: p.id, name: 'Cola', quantity: 1, price: 500 }])).receipt.slice(0, 9), `STC-${dev}-`);
});
