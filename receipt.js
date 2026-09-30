import { getSetting, setSetting } from '../db/db.js';
// Two offline phones must not both print STC-000001, so each receipt carries the first 4 characters of its phone's id.
// (The real unique key is always the sale's UUID; the receipt number is for humans.)
export async function nextReceipt() {
  const n = Number((await getSetting('receipt_counter')) || 0) + 1;
  const dev = String((await getSetting('device_id')) || '').replace(/-/g, '').slice(0, 4).toUpperCase().padEnd(4, '0');
  return { n, no: `STC-${dev}-${String(n).padStart(6, '0')}` };
}
export const commitReceipt = (n) => setSetting('receipt_counter', n);
