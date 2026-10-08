-- Java Lounge content booking: full schema for Supabase.
-- Run once in the Supabase dashboard: SQL Editor -> New query -> paste -> Run.
-- Safe to re-run (uses IF NOT EXISTS / CREATE OR REPLACE where possible).

create extension if not exists pgcrypto with schema extensions;

-- ---------- tables ----------
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text unique not null,
  name text not null,
  role text not null check (role in ('admin','staff')),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.bookings (
  id bigint generated always as identity primary key,
  slot_date date not null,
  slot_no smallint not null check (slot_no in (1,2)),
  requester_name text not null check (char_length(btrim(requester_name)) between 2 and 80),
  branch text check (branch is null or char_length(btrim(branch)) between 2 and 60),
  requirement text not null check (char_length(btrim(requirement)) between 3 and 4000),
  status text not null default 'received'
    check (status in ('received','working','approval','rejected','completed')),
  assigned_to uuid references public.profiles(id) on delete set null,
  assigned_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (slot_date, slot_no)
);
create index if not exists bookings_status_idx on public.bookings (status);

create table if not exists public.status_history (
  id bigint generated always as identity primary key,
  booking_id bigint not null references public.bookings(id) on delete cascade,
  status text not null,
  changed_by_name text not null,
  changed_at timestamptz not null default now()
);
create index if not exists status_history_booking_idx on public.status_history (booking_id);

-- ---------- helpers ----------
create or replace function public.is_staff() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles where id = auth.uid() and active)
$$;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles where id = auth.uid() and active and role = 'admin')
$$;

-- ---------- triggers ----------
create or replace function public.bookings_before_update() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.updated_at := now();
  if new.assigned_to is distinct from old.assigned_to then
    new.assigned_name := (select name from public.profiles where id = new.assigned_to);
  end if;
  return new;
end $$;

create or replace function public.bookings_after_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.status_history (booking_id, status, changed_by_name)
  values (new.id, new.status, 'Requester');
  return new;
end $$;

create or replace function public.bookings_after_update() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.status is distinct from old.status then
    insert into public.status_history (booking_id, status, changed_by_name)
    values (new.id, new.status,
            coalesce((select name from public.profiles where id = auth.uid()), 'Staff'));
  end if;
  return new;
end $$;

drop trigger if exists trg_bookings_bu on public.bookings;
create trigger trg_bookings_bu before update on public.bookings
  for each row execute function public.bookings_before_update();
drop trigger if exists trg_bookings_ai on public.bookings;
create trigger trg_bookings_ai after insert on public.bookings
  for each row execute function public.bookings_after_insert();
drop trigger if exists trg_bookings_au on public.bookings;
create trigger trg_bookings_au after update on public.bookings
  for each row execute function public.bookings_after_update();

-- ---------- row level security ----------
alter table public.profiles enable row level security;
alter table public.bookings enable row level security;
alter table public.status_history enable row level security;

drop policy if exists profiles_read on public.profiles;
create policy profiles_read on public.profiles for select to authenticated using (public.is_staff());

drop policy if exists bookings_read on public.bookings;
create policy bookings_read on public.bookings for select to anon, authenticated using (true);

-- Anyone may book: only a fresh "received" booking, today (Colombo) up to 5 years ahead.
drop policy if exists bookings_insert on public.bookings;
create policy bookings_insert on public.bookings for insert to anon, authenticated
  with check (
    status = 'received' and assigned_to is null and assigned_name is null
    and branch is not null
    and slot_date >= (now() at time zone 'Asia/Colombo')::date
    and slot_date <= (now() at time zone 'Asia/Colombo')::date + interval '5 years'
    and (slot_date >= (now() at time zone 'Asia/Colombo')::date + 3 or public.is_staff())
  );

drop policy if exists bookings_update on public.bookings;
create policy bookings_update on public.bookings for update to authenticated
  using (public.is_staff()) with check (public.is_staff());

drop policy if exists bookings_delete on public.bookings;
create policy bookings_delete on public.bookings for delete to authenticated using (public.is_staff());

drop policy if exists history_read on public.status_history;
create policy history_read on public.status_history for select to anon, authenticated using (true);

-- ---------- privileges (tight, column-level for writes) ----------
revoke all on public.profiles, public.bookings, public.status_history from anon, authenticated;
grant select on public.profiles to authenticated;
grant select on public.bookings, public.status_history to anon, authenticated;
grant insert (slot_date, slot_no, requester_name, branch, requirement) on public.bookings to anon, authenticated;
grant update (status, assigned_to) on public.bookings to authenticated;
grant delete on public.bookings to authenticated;
grant usage on sequence public.bookings_id_seq to anon, authenticated;

-- ---------- backend user management (admin only, no service key needed) ----------
-- Internal helper: not callable from the browser.
create or replace function public._create_user(p_username text, p_name text, p_password text, p_role text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := gen_random_uuid();
  mail text := lower(btrim(p_username)) || '@javalounge.app';
begin
  if lower(btrim(p_username)) !~ '^[a-z0-9._-]{3,30}$' then raise exception 'Username: 3-30 chars, letters/numbers . _ -'; end if;
  if btrim(coalesce(p_name,'')) = '' then raise exception 'Name is required'; end if;
  if char_length(coalesce(p_password,'')) < 6 then raise exception 'Password must be at least 6 characters'; end if;
  if p_role not in ('admin','staff') then raise exception 'Invalid role'; end if;
  if exists (select 1 from public.profiles where username = lower(btrim(p_username))) then
    raise exception 'Username taken';
  end if;

  insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
      raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
      confirmation_token, recovery_token, email_change_token_new, email_change)
  values ('00000000-0000-0000-0000-000000000000', uid, 'authenticated', 'authenticated', mail,
      extensions.crypt(p_password, extensions.gen_salt('bf')), now(),
      '{"provider":"email","providers":["email"]}', '{}', now(), now(), '', '', '', '');

  insert into auth.identities (id, user_id, identity_data, provider, provider_id, last_sign_in_at, created_at, updated_at)
  values (gen_random_uuid(), uid,
      jsonb_build_object('sub', uid::text, 'email', mail, 'email_verified', true),
      'email', uid::text, now(), now(), now());

  insert into public.profiles (id, username, name, role) values (uid, lower(btrim(p_username)), btrim(p_name), p_role);
  return uid;
end $$;
revoke all on function public._create_user(text,text,text,text) from public, anon, authenticated;

create or replace function public.create_staff_user(p_username text, p_name text, p_password text, p_role text)
returns uuid language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'Admins only'; end if;
  return public._create_user(p_username, p_name, p_password, p_role);
end $$;

create or replace function public.set_staff_active(p_id uuid, p_active boolean)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'Admins only'; end if;
  if p_id = auth.uid() then raise exception 'You cannot disable yourself'; end if;
  update public.profiles set active = p_active where id = p_id;
end $$;

create or replace function public.reset_staff_password(p_id uuid, p_password text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'Admins only'; end if;
  if char_length(coalesce(p_password,'')) < 6 then raise exception 'Password must be at least 6 characters'; end if;
  update auth.users set encrypted_password = extensions.crypt(p_password, extensions.gen_salt('bf')), updated_at = now()
  where id = p_id;
end $$;

revoke all on function public.create_staff_user(text,text,text,text), public.set_staff_active(uuid,boolean),
  public.reset_staff_password(uuid,text) from public, anon;
grant execute on function public.create_staff_user(text,text,text,text), public.set_staff_active(uuid,boolean),
  public.reset_staff_password(uuid,text) to authenticated;
