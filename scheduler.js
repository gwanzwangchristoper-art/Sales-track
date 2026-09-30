import { setOnWrite } from '../db/db.js';
import { syncNow } from './engine.js';
import { cloudApi } from './cloudApi.js';
// Sync soon after any local write, when the network returns, and every minute (that is the retry).
let timer;
const request = (ms) => { clearTimeout(timer); timer = setTimeout(() => syncNow(cloudApi).catch(() => {}), ms); };
export function startSync() {
  setOnWrite(() => request(3000));
  window.addEventListener('online', () => request(500));
  setInterval(() => request(0), 60000);
  request(1000);
}
