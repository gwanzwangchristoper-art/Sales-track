// Passwords are never stored: only a salted PBKDF2 hash (310k iterations) for local unlock.
// Cloud sign-in (Phase 7) is handled by Supabase Auth, which hashes server-side.
const enc = new TextEncoder();
const b64 = b => btoa(String.fromCharCode(...new Uint8Array(b)));
export const newSalt = () => b64(crypto.getRandomValues(new Uint8Array(16)));
export async function hash(secret, salt) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', iterations: 310000, salt: Uint8Array.from(atob(salt), c => c.charCodeAt(0)) }, key, 256);
  return b64(bits);
}
// 10 characters from a 32-letter alphabet (no I, O, 0, 1) = 50 bits. Long enough that guessing a
// code inside its 5-minute life is not realistic; short enough to type. The QR carries the same code.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const pairingCode = () => Array.from(crypto.getRandomValues(new Uint8Array(10)), b => ALPHABET[b % 32]).join('');
export const normalizeCode = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
export const formatCode = (c) => c.slice(0, 5) + '-' + c.slice(5);
