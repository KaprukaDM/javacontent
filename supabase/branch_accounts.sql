-- Branch accounts: every outlet gets its own login. The whole front end requires sign-in.
-- Run in the Supabase SQL Editor AFTER setup.sql, user_management.sql, add_branch.sql, lead_time.sql.
-- Safe to re-run. Afterwards run:  select * from public.seed_branch_users();   (creates the 20 logins)

-- ---------- profiles: branch role ----------
alter table public.profiles add column if not exists branch text;
alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check check (role in ('admin','staff','branch'));
alter table public.profiles drop constraint if exists profiles_branch_required;
alter table public.profiles add constraint profiles_branch_required check (role <> 'branch' or branch is not null);

-- ---------- helpers ----------
create or replace function public.is_staff() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles where id = auth.uid() and active and role in ('admin','staff'))
$$;

create or replace function public.my_branch() returns text
language sql stable security definer set search_path = '' as $$
  select branch from public.profiles where id = auth.uid() and active and role = 'branch'
$$;

create or replace function public.is_member() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles where id = auth.uid() and active)
$$;

-- only backend users can be assigned to a booking
create or replace function public.bookings_before_update() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.updated_at := now();
  if new.assigned_to is distinct from old.assigned_to then
    if new.assigned_to is not null and not exists
       (select 1 from public.profiles where id = new.assigned_to and role in ('admin','staff')) then
      raise exception 'Bookings can only be assigned to backend users';
    end if;
    new.assigned_name := (select name from public.profiles where id = new.assigned_to);
  end if;
  return new;
end $$;

-- ---------- lock the front end: no anonymous access ----------
revoke all on public.bookings, public.status_history from anon;
revoke usage on sequence public.bookings_id_seq from anon;

drop policy if exists profiles_read on public.profiles;
create policy profiles_read on public.profiles for select to authenticated
  using (id = auth.uid() or public.is_staff());

drop policy if exists bookings_read on public.bookings;
create policy bookings_read on public.bookings for select to authenticated
  using (public.is_staff() or branch = public.my_branch());

-- Branches book for themselves (3+ days ahead); staff can book any branch from today.
drop policy if exists bookings_insert on public.bookings;
create policy bookings_insert on public.bookings for insert to authenticated
  with check (
    status = 'received' and assigned_to is null and assigned_name is null
    and branch is not null
    and slot_date >= (now() at time zone 'Asia/Colombo')::date
    and slot_date <= (now() at time zone 'Asia/Colombo')::date + interval '5 years'
    and (
      public.is_staff()
      or (branch = public.my_branch()
          and slot_date >= (now() at time zone 'Asia/Colombo')::date + 3)
    )
  );

drop policy if exists history_read on public.status_history;
create policy history_read on public.status_history for select to authenticated
  using (exists (select 1 from public.bookings b where b.id = booking_id));  -- bookings RLS applies

-- Calendar view: every signed-in user sees which slots are taken and by which branch,
-- but only the owning branch (and staff) sees the requester's name.
create or replace view public.calendar_slots as
select b.id, b.slot_date, b.slot_no, b.status, b.branch,
       (public.is_staff() or b.branch = public.my_branch()) as mine,
       case when public.is_staff() or b.branch = public.my_branch() then b.requester_name end as requester_name
from public.bookings b
where public.is_member();
revoke all on public.calendar_slots from public, anon;
grant select on public.calendar_slots to authenticated;

-- ---------- user management with branch support ----------
drop function if exists public._create_user(text,text,text,text);
drop function if exists public.create_staff_user(text,text,text,text);
drop function if exists public.update_staff_user(uuid,text,text,text,text);

create or replace function public._create_user(
  p_username text, p_name text, p_password text, p_role text, p_branch text default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := gen_random_uuid();
  uname text := lower(btrim(p_username));
  mail text := lower(btrim(p_username)) || '@javalounge.app';
begin
  if uname !~ '^[a-z0-9._-]{3,30}$' then raise exception 'Username: 3-30 chars, letters/numbers . _ -'; end if;
  if btrim(coalesce(p_name,'')) = '' then raise exception 'Name is required'; end if;
  if char_length(coalesce(p_password,'')) < 6 then raise exception 'Password must be at least 6 characters'; end if;
  if p_role not in ('admin','staff','branch') then raise exception 'Invalid role'; end if;
  if p_role = 'branch' and btrim(coalesce(p_branch,'')) = '' then raise exception 'Branch is required for branch users'; end if;
  if exists (select 1 from public.profiles where username = uname) then raise exception 'Username taken'; end if;

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

  insert into public.profiles (id, username, name, role, branch)
  values (uid, uname, btrim(p_name), p_role, case when p_role = 'branch' then btrim(p_branch) end);
  return uid;
end $$;
revoke all on function public._create_user(text,text,text,text,text) from public, anon, authenticated;

create or replace function public.create_staff_user(
  p_username text, p_name text, p_password text, p_role text, p_branch text default null)
returns uuid language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'Admins only'; end if;
  return public._create_user(p_username, p_name, p_password, p_role, p_branch);
end $$;

create or replace function public.update_staff_user(
  p_id uuid, p_username text, p_name text, p_role text, p_password text default null, p_branch text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare
  uname text := lower(btrim(p_username));
  mail text := lower(btrim(p_username)) || '@javalounge.app';
begin
  if not public.is_admin() then raise exception 'Admins only'; end if;
  if not exists (select 1 from public.profiles where id = p_id) then raise exception 'User not found'; end if;
  if uname !~ '^[a-z0-9._-]{3,30}$' then raise exception 'Username: 3-30 chars, letters/numbers . _ -'; end if;
  if btrim(coalesce(p_name,'')) = '' then raise exception 'Name is required'; end if;
  if p_role not in ('admin','staff','branch') then raise exception 'Invalid role'; end if;
  if p_id = auth.uid() and p_role <> 'admin' then raise exception 'You cannot remove your own admin role'; end if;
  if p_password is not null and p_password <> '' and char_length(p_password) < 6 then
    raise exception 'Password must be at least 6 characters';
  end if;
  if exists (select 1 from public.profiles where username = uname and id <> p_id) then raise exception 'Username taken'; end if;
  if p_role = 'branch' and btrim(coalesce(p_branch, (select branch from public.profiles where id = p_id), '')) = '' then
    raise exception 'Branch is required for branch users';
  end if;

  update public.profiles
     set username = uname, name = btrim(p_name), role = p_role,
         branch = case when p_role = 'branch' then btrim(coalesce(p_branch, branch)) end
   where id = p_id;
  update auth.users set email = mail, updated_at = now() where id = p_id;
  update auth.identities set identity_data = jsonb_set(identity_data, '{email}', to_jsonb(mail)), updated_at = now()
   where user_id = p_id and provider = 'email';
  if p_password is not null and p_password <> '' then
    update auth.users set encrypted_password = extensions.crypt(p_password, extensions.gen_salt('bf')) where id = p_id;
  end if;
  update public.bookings set assigned_name = btrim(p_name) where assigned_to = p_id;
end $$;

revoke all on function public.create_staff_user(text,text,text,text,text), public.update_staff_user(uuid,text,text,text,text,text) from public, anon;
grant execute on function public.create_staff_user(text,text,text,text,text), public.update_staff_user(uuid,text,text,text,text,text) to authenticated;

-- ---------- one login per branch ----------
-- Run:  select * from public.seed_branch_users();
-- Returns branch, username and a random password. COPY THE RESULT NOW: passwords are stored hashed
-- and cannot be shown again (admin can reset any password later in the Users tab).
-- Branches that already have an account are skipped (password column is null).
create or replace function public.seed_branch_users()
returns table (branch text, username text, password text)
language plpgsql security definer set search_path = '' as $$
declare
  b text; u text; pw text;
begin
  foreach b in array array[
    'Bambalapitiya','Barnes Place','Colombo 01 (Fort)','Jawattha','Mount Lavinia','Nawala','Nugegoda','Pelawatta','Weli Park',
    'Kandy','Peradeniya','Ambuluwawa','Weligama',
    'Battaramulla','Gamsaba Junction','Kelaniya (Kiribathgoda)','Makumbura (Kottawa)','Negombo','Piliyandala','Wellawatte']
  loop
    u := trim(both '-' from regexp_replace(lower(b), '[^a-z0-9]+', '-', 'g'));
    if exists (select 1 from public.profiles p where p.username = u) then
      seed_branch_users.branch := b; seed_branch_users.username := u; seed_branch_users.password := null;
    else
      pw := translate(encode(extensions.gen_random_bytes(9), 'base64'), '+/=', 'xyz');
      perform public._create_user(u, b, pw, 'branch', b);
      seed_branch_users.branch := b; seed_branch_users.username := u; seed_branch_users.password := pw;
    end if;
    return next;
  end loop;
end $$;
revoke all on function public.seed_branch_users() from public, anon, authenticated;
