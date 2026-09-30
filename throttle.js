// After 5 wrong passwords in a row the phone makes you wait: 30 s, then doubling each time, up to 15 minutes.
// It is per phone (not per username), so it also leaks nothing about which accounts exist.
export const lockoutSeconds = (fails) => (fails < 5 ? 0 : Math.min(900, 30 * 2 ** (fails - 5)));
// Auto-lock: has the phone been idle for at least `minutes`? 0 means never.
export const shouldLock = (lastActiveMs, nowMs, minutes) => minutes > 0 && nowMs - lastActiveMs >= minutes * 60000;
