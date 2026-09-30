import { q } from '../db/db.js';
import { currentUser } from '../auth/auth.js';
import { require_ } from '../auth/permissions.js';

// Only CONFIRMED sales count. Calculations and unconfirmed transactions never appear in business figures.
const day = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const iso = (d) => d.toISOString();

export function rangeFor(key, from, to) {
  const today = day(new Date());
  const monday = addDays(today, -((today.getDay() + 6) % 7));
  const r = {
    today: [today, addDays(today, 1)], yesterday: [addDays(today, -1), today],
    week: [monday, addDays(today, 1)], month: [new Date(today.getFullYear(), today.getMonth(), 1), addDays(today, 1)],
    custom: [from ? new Date(from + 'T00:00:00') : today, addDays(to ? new Date(to + 'T00:00:00') : today, 1)],
  }[key];
  return { start: iso(r[0]), end: iso(r[1]), days: Math.round((r[1] - r[0]) / 864e5) };
}

const totals = async (start, end) => (await q(`SELECT IFNULL(SUM(corrects_sale_id IS NULL),0) n, IFNULL(SUM(total),0) revenue FROM sales
  WHERE status IN ('confirmed','corrected') AND created_at>=? AND created_at<?`, [start, end]))[0];

export async function dashboard(key, from, to) {
  require_(currentUser(), 'view_analysis');
  const { start, end, days } = rangeFor(key, from, to);
  const [main, top, trend, profit, inv] = await Promise.all([
    totals(start, end),
    q(`SELECT si.product_name name, SUM(si.quantity) qty, SUM(si.subtotal) revenue FROM sale_items si JOIN sales s ON s.id=si.sale_id
       WHERE s.status IN ('confirmed','corrected') AND s.created_at>=? AND s.created_at<? GROUP BY si.product_id HAVING qty>0 ORDER BY qty DESC LIMIT 5`, [start, end]),
    // one day: bars per hour; longer ranges: bars per day (device local time)
    q(`SELECT strftime('${days <= 1 ? '%H' : '%Y-%m-%d'}', datetime(created_at,'localtime')) label, SUM(total) value FROM sales
       WHERE status IN ('confirmed','corrected') AND created_at>=? AND created_at<? GROUP BY label ORDER BY label`, [start, end]),
    // cost = price at time of sale, or the product's current buying price for older rows
    q(`SELECT IFNULL(SUM(CASE WHEN c IS NOT NULL THEN si.subtotal - si.quantity*c END),0) profit,
       SUM(CASE WHEN c IS NULL THEN 1 ELSE 0 END) missing FROM (
       SELECT si.*, COALESCE(si.unit_cost, p.buy_price) c FROM sale_items si JOIN sales s ON s.id=si.sale_id
       LEFT JOIN products p ON p.id=si.product_id WHERE s.status IN ('confirmed','corrected') AND s.created_at>=? AND s.created_at<?) si`, [start, end]),
    q(`SELECT COUNT(*) products, IFNULL(SUM(quantity*buy_price),0) cost_value, IFNULL(SUM(quantity*sell_price),0) sell_value,
       SUM(CASE WHEN low_stock_threshold>0 AND quantity<=low_stock_threshold THEN 1 ELSE 0 END) low FROM products WHERE active=1`),
  ]);
  const today = day(new Date());
  const snap = {};
  for (const [k, a, b] of [['today', today, addDays(today, 1)], ['week', rangeFor('week').start, addDays(today, 1)], ['month', rangeFor('month').start, addDays(today, 1)]])
    snap[k] = await totals(iso(new Date(a)), iso(b));
  snap.all = await totals('0000', '9999');
  const lowList = await q(`SELECT name, quantity, low_stock_threshold th FROM products WHERE active=1 AND low_stock_threshold>0 AND quantity<=low_stock_threshold ORDER BY quantity LIMIT 10`);
  return { main, top, trend, profit: profit[0], inv: inv[0], snap, lowList };
}
