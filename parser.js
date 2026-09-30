// Pure text logic (no plugins) so it can be unit-tested. OCR is never trusted: every
// guess is shown to the admin for review, and shaky rows are flagged 'low'.
const NUM = /\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g;
const toNum = (s) => parseFloat(s.replace(/,/g, ''));
const SKIP = /total|vat|tax|discount|change|balance|amount due|paid|cash|tel\b|phone|address|invoice|bill to|page|receipt|date/i;
const MONTHS = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
const pad = (n) => String(n).padStart(2, '0');

// OCR gives boxes, not rows. Cluster boxes on the same horizontal line and read them left to right.
export function groupRows(dets) {
  const boxes = dets.map(d => {
    const tl = d.topLeft || d.bottomLeft || [0, 0], bl = d.bottomLeft || d.topLeft || [0, 0];
    return { text: d.text, x: tl[0], y: (tl[1] + bl[1]) / 2, h: Math.abs(bl[1] - tl[1]) || 10 };
  }).sort((a, b) => a.y - b.y);
  if (!boxes.length) return [];
  const tol = 0.6 * boxes.map(b => b.h).sort((a, b) => a - b)[Math.floor(boxes.length / 2)];
  const rows = [];
  for (const b of boxes) {
    const r = rows[rows.length - 1];
    if (r && Math.abs(b.y - r.y) <= tol) { r.items.push(b); r.y = (r.y * (r.items.length - 1) + b.y) / r.items.length; }
    else rows.push({ y: b.y, items: [b] });
  }
  return rows.map(r => r.items.sort((a, b) => a.x - b.x).map(i => i.text).join(' '));
}

function parseDate(rows) {
  for (const r of rows) {
    let m;
    if ((m = /(\d{4})-(\d{2})-(\d{2})/.exec(r))) return m[0];
    if ((m = /(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})/.exec(r))) {
      let [d, mo, y] = [+m[1], +m[2], +m[3]]; if (y < 100) y += 2000;
      if (mo > 12 && d <= 12) [d, mo] = [mo, d]; // day-first unless clearly month-first
      if (d >= 1 && d <= 31 && mo >= 1 && mo <= 12) return `${y}-${pad(mo)}-${pad(d)}`;
    }
    if ((m = /(\d{1,2})\s+([A-Za-z]{3})[a-z]*\.?,?\s+(\d{4})/.exec(r)) && MONTHS.includes(m[2].toLowerCase()))
      return `${m[3]}-${pad(MONTHS.indexOf(m[2].toLowerCase()) + 1)}-${pad(+m[1])}`;
  }
  return '';
}

function interpret(nums) {
  const n = nums.length, ok = (q, p, t) => Math.abs(q * p - t) <= Math.max(1, 0.01 * t);
  if (n >= 3) {
    const [a, b, c] = nums.slice(-3).map(x => x.v);
    if (ok(a, b, c)) return { q: a, p: b, t: c, conf: 'high', used: 3 };
    if (ok(b, a, c)) return { q: b, p: a, t: c, conf: 'high', used: 3 }; // price before quantity
    return { q: a, p: b, t: c, conf: 'low', used: 3 };
  }
  const [a, b] = nums.map(x => x.v);
  return { q: a, p: b, t: a * b, conf: 'low', used: 2 };
}

export function parseInvoice(input) {
  const rows = input.map(r => r.trim()).filter(Boolean);
  const header = { supplier: '', invoiceNo: '', date: parseDate(rows) };
  let statedTotal = null;
  for (const r of rows) {
    const m = /(?:invoice|inv)\.?\s*(?:no\.?|number|#)?\s*[:#.\-]?\s*([A-Z0-9][A-Z0-9\-\/]{2,})/i.exec(r);
    if (!header.invoiceNo && m && /\d/.test(m[1])) header.invoiceNo = m[1];
    if (/total|amount due/i.test(r) && !/sub/i.test(r)) {
      const v = [...r.replace(/\bN(?=\d)/g, '').matchAll(NUM)].map(x => toNum(x[0]));
      if (v.length) statedTotal = Math.max(...v);
    }
  }
  header.supplier = rows.slice(0, 5).find(r => (r.match(/[A-Za-z]/g) || []).length >= 3 && !SKIP.test(r) && !/\d{4,}/.test(r)) || '';

  const items = [];
  for (const raw of rows) {
    if (SKIP.test(raw)) continue;
    const row = raw.replace(/₦|NGN/gi, ' ').replace(/\bN(?=\d)/g, ' ');
    const nums = [...row.matchAll(NUM)].map(m => ({ v: toNum(m[0]), idx: m.index }));
    if (nums.length < 2) continue;
    const it = interpret(nums), first = nums[nums.length - it.used];
    let name = row.slice(0, first.idx).replace(/(?<![A-Za-z])[xX×*@](?![A-Za-z])/g, ' ');
    // drop a leading line number ("1 Coca Cola") but keep names like "7 Up"
    const idx = /^(\d{1,3})([.)]?)\s+(.+)$/.exec(name.trim());
    if (idx && (idx[2] || (idx[3].match(/[A-Za-z]/g) || []).length >= 3)) name = idx[3];
    name = name.replace(/\b(pcs?|cs|ctn|carton|packs?|bags?|units?|each)\b/gi, ' ').replace(/\s+/g, ' ').trim();
    if ((name.match(/[A-Za-z]/g) || []).length < 2) continue;
    items.push({ name, quantity: it.q, unitPrice: it.p, total: it.t, confidence: it.conf, raw });
  }
  return { header, items, statedTotal };
}

// Dice coefficient on letter pairs: 1 = identical. Used to suggest existing products.
export function similarity(a, b) {
  const n = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  a = n(a); b = n(b);
  if (!a || !b) return 0; if (a === b) return 1; if (a.length < 2 || b.length < 2) return 0;
  const g = (s) => { const m = new Map(); for (let i = 0; i < s.length - 1; i++) { const k = s.slice(i, i + 2); m.set(k, (m.get(k) || 0) + 1); } return m; };
  const A = g(a), B = g(b); let hit = 0;
  for (const [k, c] of A) hit += Math.min(c, B.get(k) || 0);
  return (2 * hit) / (a.length - 1 + b.length - 1);
}
