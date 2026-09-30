// Small password box (window.prompt would show the password in plain text).
export function askPassword(message = 'Enter your password to continue.') {
  return new Promise((resolve) => {
    const o = document.createElement('div'); o.className = 'overlay';
    o.innerHTML = `<div class="sheet"><h2>Confirm it's you</h2><p class="sub"></p><input type="password" autocomplete="current-password" aria-label="Password">
      <div class="two"><button class="btn alt" data-x>Cancel</button><button class="btn" data-ok>Continue</button></div></div>`;
    o.querySelector('.sub').textContent = message; document.body.appendChild(o);
    const inp = o.querySelector('input'); inp.focus();
    const done = (v) => { o.remove(); resolve(v); };
    o.querySelector('[data-ok]').onclick = () => done(inp.value); o.querySelector('[data-x]').onclick = () => done(null);
  });
}
// Runs an action; if it asks for a recent password check, asks once and retries.
export async function withReauth(fn, reauthenticate) {
  try { return await fn(); } catch (e) {
    if (e.code !== 'REAUTH') throw e;
    const pw = await askPassword(); if (pw == null) throw new Error('Cancelled.');
    await reauthenticate(pw); return fn();
  }
}
