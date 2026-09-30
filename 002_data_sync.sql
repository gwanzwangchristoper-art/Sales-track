-- Business data for sync. Run after 001_identity.sql.
-- Design: append-only tables (no update/delete policy for anyone, including admins) + versioned products.
-- Product QUANTITY is not stored: stock is the sum of inventory_transactions, so -10 and -7 from two devices always add up.

create or replace function touch_synced() returns trigger language plpgsql as $$
begin new.synced_at := clock_timestamp(); return new; end $$;          -- server clock: pull cursors never depend on phone clocks
create or replace function bump_version() returns trigger language plpgsql as $$
begin new.version := old.version + 1; new.synced_at := clock_timestamp(); return new; end $$;
create or replace function status_rank(s text) returns int language sql immutable as $$
  select case s when 'calculated' then 1 when 'confirmed' then 2 when 'corrected' then 3 when 'voided' then 3 else 0 end $$;
create or replace function keep_sale_history() returns trigger language plpgsql as $$
begin  -- a sale's status only moves forward and its original figures can never be rewritten
  if status_rank(new.status) < status_rank(old.status) then new.status := old.status; end if;
  new.total := old.total; new.receipt_no := old.receipt_no; new.user_id := old.user_id; new.created_at := old.created_at;
  new.synced_at := clock_timestamp(); return new; end $$;

create table categories(id uuid primary key, business_id uuid not null references businesses(id) on delete cascade, device_id uuid,
  created_at timestamptz not null, updated_at timestamptz not null, synced_at timestamptz not null default clock_timestamp(), name text not null);
create table products(id uuid primary key, business_id uuid not null references businesses(id) on delete cascade, device_id uuid,
  created_at timestamptz not null, updated_at timestamptz not null, synced_at timestamptz not null default clock_timestamp(), version int not null default 1,
  name text not null, sku text, barcode text, category_id uuid, buy_price double precision, sell_price double precision not null default 0,
  low_stock_threshold double precision default 0, supplier text, description text, image_ref text, active smallint default 1);
create table sales(id uuid primary key, business_id uuid not null references businesses(id) on delete cascade, device_id uuid,
  created_at timestamptz not null, updated_at timestamptz not null, synced_at timestamptz not null default clock_timestamp(),
  receipt_no text, user_id uuid, status text not null, total double precision not null);
create table sale_items(id uuid primary key, business_id uuid not null references businesses(id) on delete cascade, device_id uuid,
  created_at timestamptz not null, updated_at timestamptz not null, synced_at timestamptz not null default clock_timestamp(),
  sale_id uuid not null, product_id uuid, product_name text not null, quantity double precision not null, unit_price double precision not null,
  subtotal double precision not null, unit_cost double precision);
create table calculations(id uuid primary key, business_id uuid not null references businesses(id) on delete cascade, device_id uuid,
  created_at timestamptz not null, updated_at timestamptz not null, synced_at timestamptz not null default clock_timestamp(),
  user_id uuid, expression text not null, result double precision);
create table invoices(id uuid primary key, business_id uuid not null references businesses(id) on delete cascade, device_id uuid,
  created_at timestamptz not null, updated_at timestamptz not null, synced_at timestamptz not null default clock_timestamp(),
  supplier text, invoice_no text, invoice_date text, image_ref text, ocr_text text, status text, total double precision, user_id uuid);
create table invoice_items(id uuid primary key, business_id uuid not null references businesses(id) on delete cascade, device_id uuid,
  created_at timestamptz not null, updated_at timestamptz not null, synced_at timestamptz not null default clock_timestamp(),
  invoice_id uuid not null, product_id uuid, name text not null, quantity double precision not null, unit_price double precision not null,
  total double precision not null, is_new_product smallint default 0);
create table inventory_transactions(id uuid primary key, business_id uuid not null references businesses(id) on delete cascade, device_id uuid,
  created_at timestamptz not null, updated_at timestamptz not null, synced_at timestamptz not null default clock_timestamp(),
  product_id uuid not null, delta double precision not null, reason text not null, ref_id text, note text, user_id uuid);
create table audit_logs(id uuid primary key, business_id uuid not null references businesses(id) on delete cascade, device_id uuid,
  created_at timestamptz not null, updated_at timestamptz not null, synced_at timestamptz not null default clock_timestamp(),
  user_id uuid, action text not null, old_value text, new_value text, reason text);

create trigger t_cat_ins before insert on categories for each row execute function touch_synced();
create trigger t_cat_upd before update on categories for each row execute function touch_synced();
create trigger t_prod_ins before insert on products for each row execute function touch_synced();
create trigger t_prod_upd before update on products for each row execute function bump_version();
create trigger t_sales_ins before insert on sales for each row execute function touch_synced();
create trigger t_sales_upd before update on sales for each row execute function keep_sale_history();
create trigger t_si_ins before insert on sale_items for each row execute function touch_synced();
create trigger t_calc_ins before insert on calculations for each row execute function touch_synced();
create trigger t_inv_ins before insert on invoices for each row execute function touch_synced();
create trigger t_ii_ins before insert on invoice_items for each row execute function touch_synced();
create trigger t_ledger_ins before insert on inventory_transactions for each row execute function touch_synced();
create trigger t_audit_ins before insert on audit_logs for each row execute function touch_synced();

-- Pull queries page by (synced_at, id) within a business.
create index on categories(business_id, synced_at); create index on products(business_id, synced_at);
create index on sales(business_id, synced_at);      create index on sale_items(business_id, synced_at);
create index on calculations(business_id, synced_at); create index on invoices(business_id, synced_at);
create index on invoice_items(business_id, synced_at); create index on inventory_transactions(business_id, synced_at);
create index on inventory_transactions(product_id);  create index on audit_logs(business_id, synced_at);

do $$ declare t text; begin
  foreach t in array array['categories','products','sales','sale_items','calculations','invoices','invoice_items','inventory_transactions','audit_logs'] loop
    execute format('alter table %I enable row level security', t);
  end loop; end $$;

-- READ: anyone active can read what selling needs (catalogue and stock events); history/invoices/audit follow permissions.
create policy cat_r  on categories for select using (is_active_member(business_id));
create policy prod_r on products for select using (is_active_member(business_id));
create policy led_r  on inventory_transactions for select using (is_active_member(business_id));
create policy sale_r on sales for select using (has_perm(business_id, 'view_history'));
create policy si_r   on sale_items for select using (has_perm(business_id, 'view_history'));
create policy calc_r on calculations for select using (has_perm(business_id, 'view_history'));
create policy inv_r  on invoices for select using (has_perm(business_id, 'scan_invoices'));
create policy ii_r   on invoice_items for select using (has_perm(business_id, 'scan_invoices'));
create policy aud_r  on audit_logs for select using (is_admin(business_id));

-- WRITE: each action needs its own permission, checked by the server (a modified app cannot bypass this).
create policy cat_w   on categories for insert with check (has_perm(business_id, 'edit_products'));
create policy cat_u   on categories for update using (has_perm(business_id, 'edit_products')) with check (has_perm(business_id, 'edit_products'));
create policy prod_w  on products for insert with check (has_perm(business_id, 'edit_products'));
create policy prod_u  on products for update using (has_perm(business_id, 'edit_products') or has_perm(business_id, 'scan_invoices'))
                                              with check (has_perm(business_id, 'edit_products') or has_perm(business_id, 'scan_invoices'));
create policy sale_w  on sales for insert with check (has_perm(business_id, 'sell'));
create policy sale_u  on sales for update using (has_perm(business_id, 'sell')) with check (has_perm(business_id, 'sell'));
create policy si_w    on sale_items for insert with check (has_perm(business_id, 'sell'));
create policy calc_w  on calculations for insert with check (has_perm(business_id, 'calculate'));
create policy inv_w   on invoices for insert with check (has_perm(business_id, 'scan_invoices'));
create policy ii_w    on invoice_items for insert with check (has_perm(business_id, 'scan_invoices'));
create policy led_w   on inventory_transactions for insert with check (
     (reason = 'sale'    and has_perm(business_id, 'sell'))
  or (reason = 'invoice' and has_perm(business_id, 'scan_invoices'))
  or (reason = 'opening' and has_perm(business_id, 'edit_products'))
  or (reason not in ('sale','invoice','opening') and has_perm(business_id, 'adjust_stock')));
create policy aud_w   on audit_logs for insert with check (is_active_member(business_id));
-- No delete policy exists on any table, so nobody can delete a record through the API.

grant select, insert, update on categories, products, sales to authenticated;
grant select, insert on sale_items, calculations, invoices, invoice_items, inventory_transactions, audit_logs to authenticated;
