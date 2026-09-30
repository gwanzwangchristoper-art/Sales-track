import { shouldLock } from './throttle.js';
import { getSetting } from '../db/db.js';
import { currentUser } from './auth.js';

// Locks the app after a period with no touches, and when you come back from another app after that period.
export function startAutoLock(onLock) {
  let last = Date.now();
  const bump = () => { last = Date.now(); };
  ['pointerdown', 'keydown', 'touchstart'].forEach(ev => window.addEventListener(ev, bump, { passive: true, capture: true }));
  const check = async () => {
    if (!currentUser()) return;
    const minutes = Number((await getSetting('auto_lock_minutes')) ?? 2);
    if (shouldLock(last, Date.now(), minutes)) onLock();
  };
  setInterval(check, 5000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
}
