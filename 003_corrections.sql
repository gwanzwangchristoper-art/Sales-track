-- Corrections: a correction is a NEW sales row pointing at the original (never an edit). Run after 002.
alter table sales add column if not exists corrects_sale_id uuid;
alter table sales add column if not exists correction_reason text;

create or replace function keep_sale_history() returns trigger language plpgsql as $$
begin  -- status only moves forward; the original figures and the correction link can never be rewritten
  if status_rank(new.status) < status_rank(old.status) then new.status := old.status; end if;
  new.total := old.total; new.receipt_no := old.receipt_no; new.user_id := old.user_id; new.created_at := old.created_at;
  new.corrects_sale_id := old.corrects_sale_id; new.correction_reason := old.correction_reason;
  new.synced_at := clock_timestamp(); return new; end $$;

-- Recording a correction needs the 'corrections' permission (or 'sell', as before).
drop policy sale_w on sales; drop policy sale_u on sales; drop policy si_w on sale_items; drop policy led_w on inventory_transactions;
create policy sale_w on sales for insert with check (has_perm(business_id, 'sell') or (corrects_sale_id is not null and has_perm(business_id, 'corrections')));
create policy sale_u on sales for update using (has_perm(business_id, 'sell') or has_perm(business_id, 'corrections'))
                                         with check (has_perm(business_id, 'sell') or has_perm(business_id, 'corrections'));
create policy si_w   on sale_items for insert with check (has_perm(business_id, 'sell') or has_perm(business_id, 'corrections'));
create policy led_w  on inventory_transactions for insert with check (
     (reason = 'sale'            and has_perm(business_id, 'sell'))
  or (reason = 'sale correction' and has_perm(business_id, 'corrections'))
  or (reason = 'invoice'         and has_perm(business_id, 'scan_invoices'))
  or (reason = 'opening'         and has_perm(business_id, 'edit_products'))
  or (reason not in ('sale','sale correction','invoice','opening') and has_perm(business_id, 'adjust_stock')));
