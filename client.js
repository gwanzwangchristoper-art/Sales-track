import { createClient } from '@supabase/supabase-js';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';
import { getSetting, setSetting, run } from '../db/db.js';

let forced = null; // tests plug in a fake cloud
export const cloudConfigured = () => forced ?? !SUPABASE_URL.includes('YOUR-PROJECT');
// Login tokens are kept in the encrypted local database (Phase 10 moves the DB key to the Android Keystore).
const storage = {
  getItem: async (k) => (await getSetting('sb:' + k)) ?? null,
  setItem: (k, v) => setSetting('sb:' + k, v),
  removeItem: (k) => run('DELETE FROM settings WHERE key=?', ['sb:' + k]),
};
let client;
export const setClientForTests = (c) => { client = c; forced = true; };
// Created lazily, after the database is open.
export const getClient = () => (client ||= createClient(SUPABASE_URL, SUPABASE_ANON_KEY,
  { auth: { storage, persistSession: true, autoRefreshToken: true, detectSessionInUrl: false } }));

const MSG = { invalid_or_expired_code: 'Code is invalid or expired. Ask the admin for a new one.', username_taken: 'That username is already used in this business.',
  not_allowed: 'Admin permission required.', cannot_revoke_admin: 'The admin device cannot be revoked.' };
export async function rpc(name, args) {
  if (!cloudConfigured()) throw new Error('Cloud is not set up yet. Add your Supabase URL and key in src/cloud/config.js.');
  const { data, error } = await getClient().rpc(name, args);
  if (error) {
    const k = Object.keys(MSG).find(k => error.message?.includes(k));
    throw new Error(k ? MSG[k] : 'Could not reach the cloud. Check your internet and try again.');
  }
  return data;
}
