// Safe math evaluator (no eval). Supports + - × ÷ * / ( ) and decimals, with normal precedence.
export function evaluate(expr) {
  const s = expr.replace(/×/g, '*').replace(/÷/g, '/').replace(/,/g, '').replace(/\s+/g, '');
  if (!s) throw new Error('Enter a calculation.');
  let i = 0;
  const peek = () => s[i];
  function number() {
    const m = /^\d*\.?\d+|^\d+\.?/.exec(s.slice(i));
    if (!m) throw new Error('Check the calculation.');
    i += m[0].length; return parseFloat(m[0]);
  }
  function factor() {
    if (peek() === '-') { i++; return -factor(); }
    if (peek() === '(') { i++; const v = expr_(); if (peek() !== ')') throw new Error('Missing closing bracket.'); i++; return v; }
    return number();
  }
  function term() {
    let v = factor();
    while (peek() === '*' || peek() === '/') {
      const op = s[i++], r = factor();
      if (op === '/' && r === 0) throw new Error('Cannot divide by zero.');
      v = op === '*' ? v * r : v / r;
    }
    return v;
  }
  function expr_() {
    let v = term();
    while (peek() === '+' || peek() === '-') v = s[i++] === '+' ? v + term() : v - term();
    return v;
  }
  const out = expr_();
  if (i < s.length) throw new Error('Check the calculation.');
  return Math.round(out * 1e8) / 1e8;
}
export const money = (n) => '₦' + Number(n).toLocaleString('en-NG', { maximumFractionDigits: 2 });
