import { getClient } from '../cloud/client.js';
import { ensureDeviceId } from '../auth/auth.js';
async function call(fn, args) {
  const { data, error } = await getClient().rpc(fn, args);
  if (error) { const e = new Error(error.message); e.notAllowed = /not_allowed/.test(error.message); throw e; }
  return data;
}
export const cloudApi = {
  heartbeat: async () => call('device_heartbeat', { p_device_id: await ensureDeviceId() }),
  push: (b, t, rows) => call('sync_push', { p_business_id: b, p_table: t, p_rows: rows }),
  pull: (b, t, since, limit) => call('sync_pull_table', { p_business_id: b, p_table: t, p_since: since, p_limit: limit }),
};
