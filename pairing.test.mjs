import test from 'node:test';
import assert from 'node:assert/strict';
import { pairingCode, normalizeCode, formatCode } from '../src/auth/crypto.js';
import { can, defaultPermissions } from '../src/auth/permissions.js';

test('pairing codes are 10 unambiguous characters and differ each time', () => {
  const a = pairingCode(), b = pairingCode();
  assert.match(a, /^[A-HJ-NP-Z2-9]{10}$/);
  assert.notEqual(a, b);
});
test('typed codes are forgiving about case, spaces and dashes', () => {
  assert.equal(normalizeCode(' k7qm2-xpd9f '), 'K7QM2XPD9F');
  assert.equal(formatCode('K7QM2XPD9F'), 'K7QM2-XPD9F');
  assert.equal(normalizeCode(formatCode('K7QM2XPD9F')), 'K7QM2XPD9F');
});
test('default-allow: users can do everything except admin-only actions', () => {
  const user = { role: 'user', permissions: JSON.stringify(defaultPermissions()) };
  assert.equal(can(user, 'edit_products'), true);
  assert.equal(can(user, 'revoke_devices'), false);
  assert.equal(can(user, 'edit_permissions'), false);
  assert.equal(can({ role: 'admin', permissions: '{}' }, 'revoke_devices'), true);
});
test('an admin restriction turns off exactly one permission', () => {
  const user = { role: 'user', permissions: JSON.stringify({ export: false }) };
  assert.equal(can(user, 'export'), false);
  assert.equal(can(user, 'sell'), true);
});
