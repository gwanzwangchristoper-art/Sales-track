import { q, run, uuid, now, audit, getSetting } from '../db/db.js';
import { currentUser } from '../auth/auth.js';
import { require_ } from '../auth/permissions.js';
import { ledgerStmts } from './inventory.js';
import { detId } from '../sync/ids.js';
import { tx } from '../db/db.js';

// Indexed search by name, SKU, barcode or category. Works offline; capped so it stays fast with thousands of products.
export async function searchProducts(text, limit = 20) {
  const t = (text || '').trim().toLowerCase();
  if (!t) return [];
  const like = `%${t}%`;
  return q(`SELECT p.*, c.name AS category FROM products p LEFT JOIN categories c ON c.id=p.category_id
    WHERE p.active=1 AND (lower(p.name) LIKE ? OR lower(p.sku) LIKE ? OR p.barcode=? OR lower(c.name) LIKE ?)
    ORDER BY (lower(p.name) LIKE ?) DESC, p.name LIMIT ?`, [like, like, t, like, t + '%', limit]);
}

async function categoryId(name) {
  const n = (name || '').trim();
  if (!n) return null;
  const hit = (await q('SELECT id FROM categories WHERE lower(name)=?', [n.toLowerCase()]))[0];
  if (hit) return hit.id;
  const id = await detId(`category:${currentUser().business_id}:${n.toLowerCase()}`), t = now();
  await run('INSERT OR IGNORE INTO categories(id,name,device_id,created_at,updated_at) VALUES(?,?,?,?,?)', [id, n, await getSetting('device_id'), t, t]);
  return id;
}

export async function addProduct(f) {
  const u = currentUser();
  require_(u, 'edit_products');
  const name = (f.name || '').trim(), price = Number(f.sellPrice), qty = Number(f.quantity || 0);
  if (!name) throw new Error('Enter a product name.');
  if (!(price >= 0) || f.sellPrice === '') throw new Error('Enter a selling price.');
  if (!(qty >= 0)) throw new Error('Quantity cannot be negative.');
  if (f.sku && (await q('SELECT 1 FROM products WHERE sku=?', [f.sku.trim()])).length) throw new Error('That SKU is already used.');
  const id = uuid(), t = now(), dev = await getSetting('device_id');
  await run(`INSERT INTO products(id,name,sku,barcode,category_id,quantity,buy_price,sell_price,low_stock_threshold,supplier,description,device_id,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [id, name, f.sku?.trim() || null, f.barcode?.trim() || null, await categoryId(f.category), 0,
    f.buyPrice === '' || f.buyPrice == null ? null : Number(f.buyPrice), price, Number(f.threshold || 0), f.supplier || null, f.description || null, dev, t, t]);
  if (qty > 0) await tx(ledgerStmts({ productId: id, delta: qty, reason: 'opening', note: 'Opening stock', userId: u.id, dev, t }));
  await audit(u.id, 'product_created', null, { id, name, price, qty });
  return (await q('SELECT * FROM products WHERE id=?', [id]))[0];
}
