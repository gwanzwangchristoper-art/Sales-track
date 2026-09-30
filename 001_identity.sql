-- Sales Track Calculator: identity, devices and pairing.
-- Run in the Supabase SQL editor. In Dashboard > Authentication > Providers, enable "Anonymous sign-ins"
-- (linked devices use them) and, for simplest setup, turn off "Confirm email".

create table businesses(id uuid primary key, name text, phone text, created_by uuid not null, created_at timestamptz default now());
create table members(
  id uuid primary key, business_id uuid not null references businesses(id) on delete cascade, auth_uid uuid not null,
  role text not null check (role in ('admin','user')), full_name text not null, username text not null,
  permissions jsonb not null default '{}',                 -- default-allow: only an explicit false restricts
  status text not null default 'active' check (status in ('active','revoked')), created_at timestamptz default now(),
  unique (business_id, username), unique (business_id, auth_uid));
create table devices(
  id uuid primary key, business_id uuid not null references businesses(id) on delete cascade,
  member_id uuid not null references members(id) on delete cascade, auth_uid uuid not null, name text,
  status text not null default 'active' check (status in ('active','revoked')),
  last_sync timestamptz, revoked_at timestamptz, created_at timestamptz default now());
create table pairing_codes(code_hash text primary key, business_id uuid not null references businesses(id) on delete cascade,
  created_by uuid not null, expires_at timestamptz not null, used boolean not null default false);

-- A request is allowed only while BOTH the member and the device are active, so revoking a device
-- cuts it off server-side immediately, even though its login token is still valid.
create or replace function has_perm(b uuid, perm text) returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select case when m.role = 'admin' then true
      when perm in ('manage_users','revoke_devices','edit_permissions') then false
      else coalesce((m.permissions ->> perm)::boolean, true) end
    from members m join devices d on d.member_id = m.id
    where m.business_id = b and m.auth_uid = auth.uid() and m.status = 'active' and d.auth_uid = auth.uid() and d.status = 'active' limit 1), false) $$;
create or replace function is_active_member(b uuid) returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from members m join devices d on d.member_id = m.id
    where m.business_id = b and m.auth_uid = auth.uid() and m.status = 'active' and d.auth_uid = auth.uid() and d.status = 'active') $$;
create or replace function is_admin(b uuid) returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from members m join devices d on d.member_id = m.id
    where m.business_id = b and m.role = 'admin' and m.auth_uid = auth.uid() and m.status = 'active' and d.auth_uid = auth.uid() and d.status = 'active') $$;

alter table businesses enable row level security; alter table members enable row level security;
alter table devices enable row level security;    alter table pairing_codes enable row level security;
create policy biz_read on businesses for select using (is_active_member(id));
create policy mem_read on members for select using (is_admin(business_id) or (auth_uid = auth.uid() and is_active_member(business_id)));
create policy dev_read on devices for select using (is_admin(business_id) or (auth_uid = auth.uid() and is_active_member(business_id)));
-- No insert/update/delete policies: every change goes through the functions below. pairing_codes has no policies at all.
revoke all on all tables in schema public from anon, authenticated;
grant select on businesses, members, devices to authenticated;

create or replace function create_business(p_business_id uuid, p_name text, p_phone text, p_member_id uuid, p_full_name text,
  p_username text, p_device_id uuid, p_device_name text) returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null or coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) then raise exception 'not_allowed'; end if;
  if exists (select 1 from businesses where id = p_business_id and created_by = auth.uid()) then return; end if; -- safe to retry
  insert into businesses(id, name, phone, created_by) values (p_business_id, p_name, p_phone, auth.uid());
  insert into members(id, business_id, auth_uid, role, full_name, username) values (p_member_id, p_business_id, auth.uid(), 'admin', p_full_name, lower(p_username));
  insert into devices(id, business_id, member_id, auth_uid, name) values (p_device_id, p_business_id, p_member_id, auth.uid(), p_device_name);
end $$;

create or replace function create_pairing_code(p_business_id uuid, p_code text) returns void language plpgsql security definer set search_path = public as $$
begin
  if not has_perm(p_business_id, 'link_devices') then raise exception 'not_allowed'; end if;
  delete from pairing_codes where expires_at < now() - interval '1 day';
  insert into pairing_codes(code_hash, business_id, created_by, expires_at)
  values (encode(sha256(convert_to(upper(p_code), 'utf8')), 'hex'), p_business_id, auth.uid(), now() + interval '5 minutes');
end $$;

create or replace function redeem_pairing_code(p_code text, p_member_id uuid, p_full_name text, p_username text, p_device_id uuid, p_device_name text)
returns json language plpgsql security definer set search_path = public as $$
declare pc pairing_codes%rowtype; bname text;
begin
  if auth.uid() is null then raise exception 'not_allowed'; end if;
  select * into pc from pairing_codes where code_hash = encode(sha256(convert_to(upper(p_code), 'utf8')), 'hex') for update;
  if not found or pc.used or pc.expires_at < now() then raise exception 'invalid_or_expired_code'; end if;  -- one message for every failure
  begin
    insert into members(id, business_id, auth_uid, role, full_name, username) values (p_member_id, pc.business_id, auth.uid(), 'user', p_full_name, lower(p_username));
  exception when unique_violation then raise exception 'username_taken'; end;
  insert into devices(id, business_id, member_id, auth_uid, name) values (p_device_id, pc.business_id, p_member_id, auth.uid(), p_device_name);
  update pairing_codes set used = true where code_hash = pc.code_hash;
  select name into bname from businesses where id = pc.business_id;
  return json_build_object('business_id', pc.business_id, 'business_name', bname);
end $$;

create or replace function revoke_device(p_device_id uuid) returns void language plpgsql security definer set search_path = public as $$
declare d devices%rowtype;
begin
  select * into d from devices where id = p_device_id;
  if not found or not is_admin(d.business_id) then raise exception 'not_allowed'; end if;
  if (select role from members where id = d.member_id) = 'admin' then raise exception 'cannot_revoke_admin'; end if;
  update devices set status = 'revoked', revoked_at = now() where id = p_device_id;
  update members set status = 'revoked' where id = d.member_id;
end $$;

create or replace function set_permission(p_member_id uuid, p_perm text, p_allowed boolean) returns void language plpgsql security definer set search_path = public as $$
declare b uuid;
begin
  select business_id into b from members where id = p_member_id and role = 'user';
  if b is null or not is_admin(b) then raise exception 'not_allowed'; end if;
  if p_perm not in ('calculate','sell','view_history','edit_products','adjust_stock','scan_invoices','view_analysis','export','change_settings','corrections','link_devices')
    then raise exception 'not_allowed'; end if;
  update members set permissions = jsonb_set(permissions, array[p_perm], to_jsonb(p_allowed)) where id = p_member_id;
end $$;

-- A device calls this to prove it is alive and to learn whether it was revoked. Works even after revocation.
create or replace function device_heartbeat(p_device_id uuid) returns text language plpgsql security definer set search_path = public as $$
declare s text;
begin
  update devices set last_sync = now() where id = p_device_id and auth_uid = auth.uid() and status = 'active';
  select status into s from devices where id = p_device_id and auth_uid = auth.uid();
  return coalesce(s, 'unknown');
end $$;

revoke execute on all functions in schema public from public, anon;
grant execute on function create_business, create_pairing_code, redeem_pairing_code, revoke_device, set_permission, device_heartbeat to authenticated;
-- has_perm / is_admin / is_active_member stay callable by policies; they only ever report on the caller.
grant execute on function has_perm, is_admin, is_active_member to authenticated;
