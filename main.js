import { Capacitor } from '@capacitor/core';
import { setAdapter, openDb } from './db/db.js';
import { ensureDeviceId } from './auth/auth.js';
import { start, lockNow } from './ui/app.js';
import { startSync } from './sync/engine.js';
import { startAutoLock } from './auth/lock.js';
(async () => {
  // Android build: encrypted database with a Keystore key. Browser: IndexedDB-backed SQLite for trying the app on a computer.
  const adapter = Capacitor.isNativePlatform() ? (await import('./db/capacitor.js')).capacitorAdapter : (await import('./db/web.js')).webAdapter;
  setAdapter(adapter); await openDb(); await ensureDeviceId(); await start(); startSync(); startAutoLock(lockNow);
})().catch(e => { document.getElementById('app').innerHTML = `<main><h2>Could not start</h2><p class="err">${String(e.message || e).replace(/</g, '&lt;')}</p></main>`; });
