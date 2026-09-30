-- Sales Track Calculator: business data + sync. Run after 001_identity.sql.
-- Ids are TEXT so a row keeps exactly the id the phone gave it. created_at/updated_at are TEXT ISO strings
-- (kept verbatim so date filters behave the same on every device). synced_at is the SERVER clock and drives pulling.
create table categories(id text primary key, business_id uuid not null references businesses(id) on delete cascade, name text not null,
  device_id text, created_at text, updated_at text, synced_at timestamptz);
create table products(id text primary key, business_id uuid not null references businesses(id) on delete cascade, name text not null, sku text, barcode text,
  category_id text, buy_price double precision, sell_price double precision not null default 0, low_stock_threshold double precision default 0,
  supplier text, description text, image_ref text, active integer default 1, device_id text, created_at text, updated_at text, synced_at timestamptz);
-- No quantity column on purpose: stock is always the SUM of the ledger below.
create table inventory_transactions(id text primary key, business_id uuid not null references businesses(id) on delete cascade, product_id text not null,
  delta double precision not null, reason text not null, ref_id text, note text, user_id text, device_id text, created_at text, updated_at text, synced_at timestamptz);
create table sales(id text primary key, business_id uuid not null references businesses(id) on delete cascade, receipt_no text, user_id text,
  status text not null default 'calculated', total double precision not null, device_id text, created_at text, updated_at text, synced_at timestamptz);
create table sale_items(id text primary key, business_id uuid not null references businesses(id) on delete cascade, sale_id text not null, product_id text,
  product_name text not null, quantity double precision, unit_price double precision, subtotal double precision, unit_cost double precision,
  device_id text, created_at text, updated_at text, synced_at timestamptz);
create table calculations(id text primary key, business_id uuid not null references businesses(id) on delete cascade, user_id text, expression text not null,
  result double precision, device_id text, created_at text, updated_at text, synced_at timestamptz);
create table invoices(id text primary key, business_id uuid not null references businesses(id) on delete cascade, supplier text, invoice_no text, invoice_date text,
  image_ref text, ocr_text text, status text, total double precision, user_id text, device_id text, created_at text, updated_at text, synced_at timestamptz);
create table invoice_items(id text primary key, business_id uuid not null references businesses(id) on delete cascade, invoice_id text not null, product_id text,
  name text not null, quantity double precision, unit_price double precision, total double precision, is_new_product integer,
  device_id text, created_at text, updated_at text, synced_at timestamptz);
create table audit_logs(id text primary key, business_id uuid not null references businesses(id) on delete cascade, user_id text, action text not null,
  old_value text, new_value text, reason text, device_id text, created_at text, updated_at text, synced_at timestamptz);
create table sync_conflicts(id text primary key, business_id uuid not null references businesses(id) on delete cascade, kind text not null, ref_id text,
  detail jsonb, status text not null default 'open', resolution text, created_at text, updated_at text, synced_at timestamptz);

do $$ declare t text; begin
  foreach t in array array['categories','products','inventory_transactions','sales','sale_items','calculations','invoices','invoice_items','audit_logs','sync_conflicts'] loop
    execute format('create index on %I (business_id, synced_at)', t);
    execute format('alter table %I enable row level security', t);   -- no policies: devices reach data only through the functions below
  end loop; end $$;
create index on inventory_transactions (business_id, product_id);

create or replace function stamp_synced() returns trigger language plpgsql as $$ begin new.synced_at := clock_timestamp(); return new; end $$;
do $$ declare t text; begin
  foreach t in array array['categories','products','inventory_transactions','sales','sale_items','calculations','invoices','invoice_items','audit_logs','sync_conflicts'] loop
    execute format('create trigger stamp before insert or update on %I for each row execute function stamp_synced()', t);
  end loop; end $$;

create or replace function status_rank(s text) returns int language sql immutable as $$ select case s when 'calculated' then 1 when 'confirmed' then 2 else 3 end $$;

create or replace function can_sync(b uuid, tbl text) returns boolean language sql stable security definer set search_path = public as $$
  select case tbl
    when 'products' then has_perm(b,'edit_products') or has_perm(b,'scan_invoices')
    when 'categories' then has_perm(b,'edit_products') or has_perm(b,'scan_invoices')
    when 'inventory_transactions' then has_perm(b,'sell') or has_perm(b,'adjust_stock') or has_perm(b,'scan_invoices') or has_perm(b,'edit_products')
    when 'sales' then has_perm(b,'sell') when 'sale_items' then has_perm(b,'sell')
    when 'calculations' then has_perm(b,'calculate')
    when 'invoices' then has_perm(b,'scan_invoices') when 'invoice_items' then has_perm(b,'scan_invoices')
    when 'audit_logs' then is_active_member(b)
    else false end $$;

-- Upload a batch. Safe to repeat: rows are keyed by id, so a retry after a dropped connection never duplicates anything.
--  * append-only tables (sales, ledger, invoices, audit...): insert, ignore if already there
--  * sales.status only moves forward (calculated -> confirmed)
--  * products: accepted only if the edit was based on the current cloud version; otherwise recorded as a conflict, never overwritten
create or replace function sync_push(p_business_id uuid, p_table text, p_rows jsonb) returns jsonb language plpgsql security definer set search_path = public as $$
declare e jsonb; cur products%rowtype; acc jsonb := '[]'; conf jsonb := '[]'; v timestamptz;
begin
  if p_table not in ('categories','products','inventory_transactions','sales','sale_items','calculations','invoices','invoice_items','audit_logs')
     or not can_sync(p_business_id, p_table) then raise exception 'not_allowed'; end if;
  if jsonb_array_length(p_rows) > 500 then raise exception 'too_many_rows'; end if;
  if exists (select 1 from jsonb_array_elements(p_rows) x where x->>'business_id' is distinct from p_business_id::text) then raise exception 'not_allowed'; end if;

  if p_table = 'products' then
    for e in select value from jsonb_array_elements(p_rows) loop
      select * into cur from products where id = e->>'id' and business_id = p_business_id;
      if not found then
        insert into products select * from jsonb_populate_recordset(null::products, jsonb_build_array(e));
      elsif e->>'base_version' is not null and (e->>'base_version')::timestamptz = cur.synced_at then
        update products set name = e->>'name', sku = e->>'sku', barcode = e->>'barcode', category_id = e->>'category_id',
          buy_price = (e->>'buy_price')::float8, sell_price = (e->>'sell_price')::float8, low_stock_threshold = (e->>'low_stock_threshold')::float8,
          supplier = e->>'supplier', description = e->>'description', image_ref = e->>'image_ref', active = (e->>'active')::int,
          device_id = e->>'device_id', updated_at = e->>'updated_at' where id = cur.id;
      elsif (cur.name, cur.sku, cur.barcode, cur.category_id, cur.buy_price, cur.sell_price, cur.low_stock_threshold, cur.supplier, cur.description, cur.active)
          is not distinct from (e->>'name', e->>'sku', e->>'barcode', e->>'category_id', (e->>'buy_price')::float8, (e->>'sell_price')::float8,
          (e->>'low_stock_threshold')::float8, e->>'supplier', e->>'description', (e->>'active')::int) then
        null; -- identical to what the cloud already has (a retried upload)
      else
        conf := conf || to_jsonb(cur.id);
        insert into sync_conflicts(id, business_id, kind, ref_id, detail, created_at, updated_at)
        values (gen_random_uuid()::text, p_business_id, 'product_edit', cur.id,
          jsonb_build_object('device', e, 'cloud', to_jsonb(cur) - 'synced_at' - 'business_id'),
          to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
        continue;
      end if;
      select synced_at into v from products where id = e->>'id';
      acc := acc || jsonb_build_object('id', e->>'id', 'v', v);
    end loop;
    return jsonb_build_object('accepted', acc, 'conflicts', conf);
  end if;

  execute format('insert into %I select * from jsonb_populate_recordset(null::%I, $1) on conflict (id) do nothing', p_table, p_table) using p_rows;

  if p_table = 'sales' then
    update sales s set status = x->>'status', updated_at = x->>'updated_at' from jsonb_array_elements(p_rows) x
     where s.id = x->>'id' and s.business_id = p_business_id and status_rank(x->>'status') > status_rank(s.status);
  end if;

  if p_table = 'inventory_transactions' then
    -- Two devices can each sell what looked available. Both sales are kept as separate ledger rows; if the total goes
    -- below zero the admin gets a conflict showing each device's share (e.g. A -10, B -7).
    insert into sync_conflicts(id, business_id, kind, ref_id, detail, created_at, updated_at)
    select gen_random_uuid()::text, p_business_id, 'negative_stock', s.product_id,
      jsonb_build_object('quantity', s.q, 'by_device', (select jsonb_object_agg(coalesce(z.device_id, '?'), z.d)
        from (select device_id, sum(delta) d from inventory_transactions where business_id = p_business_id and product_id = s.product_id group by device_id) z)),
      to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    from (select product_id, sum(delta) q from inventory_transactions
          where business_id = p_business_id and product_id in (select distinct x->>'product_id' from jsonb_array_elements(p_rows) x)
          group by product_id having sum(delta) < 0) s
    where not exists (select 1 from sync_conflicts c where c.business_id = p_business_id and c.kind = 'negative_stock' and c.ref_id = s.product_id and c.status = 'open');
  end if;

  select coalesce(jsonb_agg(jsonb_build_object('id', x->>'id')), '[]') into acc from jsonb_array_elements(p_rows) x;
  return jsonb_build_object('accepted', acc, 'conflicts', '[]'::jsonb);
end $$;

-- Download rows changed after p_since (server clock), oldest first. Devices re-read a short overlap each time; applying is idempotent.
create or replace function sync_pull_table(p_business_id uuid, p_table text, p_since timestamptz, p_limit int default 200) returns jsonb
language plpgsql security definer set search_path = public as $$
declare ok boolean; res jsonb;
begin
  if p_table not in ('categories','products','inventory_transactions','sales','sale_items','calculations','invoices','invoice_items','audit_logs','sync_conflicts')
    then raise exception 'not_allowed'; end if;
  ok := case
    when p_table in ('sync_conflicts','audit_logs') then is_admin(p_business_id)
    when p_table in ('sales','sale_items','calculations') then has_perm(p_business_id, 'view_history')
    when p_table in ('invoices','invoice_items') then has_perm(p_business_id, 'scan_invoices')
    else is_active_member(p_business_id) end;
  if not ok then raise exception 'not_allowed'; end if;
  execute format('select coalesce(jsonb_agg(t order by t.synced_at), ''[]''::jsonb) from (select * from %I where business_id = $1 and synced_at > $2 order by synced_at limit $3) t', p_table)
    into res using p_business_id, p_since, least(p_limit, 500);
  return res;
end $$;

revoke execute on all functions in schema public from public, anon;
grant execute on function create_business, create_pairing_code, redeem_pairing_code, revoke_device, set_permission, device_heartbeat, sync_push, sync_pull_table to authenticated;
grant execute on function has_perm, is_admin, is_active_member, can_sync to authenticated;
