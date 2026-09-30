import test from 'node:test';
import assert from 'node:assert/strict';
import { patchManifest, patchMainActivity } from '../scripts/patch-android.mjs';
const stock = `<?xml version="1.0" encoding="utf-8" ?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <application
        android:allowBackup="true"
        android:icon="@mipmap/ic_launcher"
        android:theme="@style/AppTheme">
        <activity android:name=".MainActivity" android:exported="true" />
    </application>
    <uses-permission android:name="android.permission.INTERNET" />
</manifest>`;
test('manifest: camera permission added, backup off, cleartext off, existing entries kept, idempotent', () => {
  const x = patchManifest(stock);
  assert.match(x, /android\.permission\.CAMERA/); assert.match(x, /android\.permission\.INTERNET/);
  assert.match(x, /android:allowBackup="false"/); assert.doesNotMatch(x, /allowBackup="true"/);
  assert.match(x, /android:usesCleartextTraffic="false"/);
  assert.equal(patchManifest(x), x);
  assert.equal((x.match(/CAMERA/g) || []).length, 1);
});
test('manifest without an allowBackup attribute still gets one', () => {
  assert.match(patchManifest(stock.replace('android:allowBackup="true"', '')), /android:allowBackup="false"/);
});
test('MainActivity: screenshots blocked, idempotent, keeps the package', () => {
  const j = patchMainActivity('package com.salestrack.calculator;\n\nimport com.getcapacitor.BridgeActivity;\n\npublic class MainActivity extends BridgeActivity {}\n');
  assert.match(j, /FLAG_SECURE/); assert.match(j, /^package com\.salestrack\.calculator;/); assert.match(j, /extends BridgeActivity/);
  assert.equal(patchMainActivity(j), j);
});
test('capacitor config is https-only and encrypted', async () => {
  const c = JSON.parse((await import('node:fs')).readFileSync('capacitor.config.json', 'utf8'));
  assert.equal(c.android.allowMixedContent, false); assert.equal(c.server.androidScheme, 'https'); assert.equal(c.plugins.CapacitorSQLite.androidIsEncryption, true);
});
