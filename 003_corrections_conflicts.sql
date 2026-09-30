-- Corrections and synced conflicts. Run after 002_data_sync.sql.
alter table sales add column corrects_sale_id uuid, add column correction_reason text;

-- A sale's status only moves forward and its figures never change. Marking a sale corrected/voided needs the 'corrections' permission.
create or replace function keep_sale_history() returns trigger language plpgsql as $$
begin
  if status_rank(new.status) < status_rank(old.status) then new.status := old.status; end if;
  if new.status in ('corrected','voided') and old.status <> new.status and not has_perm(new.business_id, 'corrections') then
    raise exception 'not allowed' using errcode = '42501'; end if;
  new.total := old.total; new.receipt_no := old.receipt_no; new.user_id := old.user_id; new.created_at := old.created_at;
  new.corrects_sale_id := old.corrects_sale_id; new.synced_at := clock_timestamp(); return new; end $$;

drop policy sale_w on sales; drop policy sale_u on sales; drop policy si_w on sale_items; drop policy led_w on inventory_transactions;
create policy sale_w on sales for insert with check (has_perm(business_id, 'sell') or has_perm(business_id, 'corrections'));
create policy sale_u on sales for update using (has_perm(business_id, 'sell') or has_perm(business_id, 'corrections'))
                                         with check (has_perm(business_id, 'sell') or has_perm(business_id, 'corrections'));
create policy si_w on sale_items for insert with check (has_perm(business_id, 'sell') or has_perm(business_id, 'corrections'));
create policy led_w on inventory_transactions for insert with check (
     (reason = 'sale'     and (has_perm(business_id, 'sell') or has_perm(business_id, 'corrections')))
  or (reason = 'reversal' and has_perm(business_id, 'corrections'))
  or (reason = 'invoice'  and has_perm(business_id, 'scan_invoices'))
  or (reason = 'opening'  and has_perm(business_id, 'edit_products'))
  or (reason not in ('sale','reversal','invoice','opening') and has_perm(business_id, 'adjust_stock')));

-- Conflict records sync, so the admin sees a conflict raised on any phone and the decision travels back to it.
create table sync_conflicts(id uuid primary key, business_id uuid not null references businesses(id) on delete cascade, device_id uuid,
  created_at timestamptz not null, updated_at timestamptz not null, synced_at timestamptz not null default clock_timestamp(),
  kind text not null, table_name text, row_id text, field text, local_value text, remote_value text, detail text,
  status text not null default 'open', resolution text, resolved_by uuid, resolved_at timestamptz);
create or replace function keep_resolved() returns trigger language plpgsql as $$
begin  -- once resolved it stays resolved, and the facts of the conflict never change
  if old.status = 'resolved' then new.status := old.status; new.resolution := old.resolution; new.resolved_by := old.resolved_by; new.resolved_at := old.resolved_at; end if;
  new.kind := old.kind; new.row_id := old.row_id; new.field := old.field; new.local_value := old.local_value; new.remote_value := old.remote_value;
  new.synced_at := clock_timestamp(); return new; end $$;
create trigger t_conf_ins before insert on sync_conflicts for each row execute function touch_synced();
create trigger t_conf_upd before update on sync_conflicts for each row execute function keep_resolved();
create index on sync_conflicts(business_id, synced_at);
alter table sync_conflicts enable row level security;
create policy conf_r on sync_conflicts for select using (is_admin(business_id) or device_id in (select id from devices where auth_uid = auth.uid() and status = 'active'));
create policy conf_w on sync_conflicts for insert with check (is_active_member(business_id));
create policy conf_u on sync_conflicts for update using (is_admin(business_id)) with check (is_admin(business_id));
grant select, insert, update on sync_conflicts to authenticated;
