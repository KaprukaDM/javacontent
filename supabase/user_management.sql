-- Edit and delete backend users (admin only). Run in the Supabase SQL Editor after setup.sql. Safe to re-run.

create or replace function public.update_staff_user(
  p_id uuid, p_username text, p_name text, p_role text, p_password text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare
  uname text := lower(btrim(p_username));
  mail text := lower(btrim(p_username)) || '@javalounge.app';
begin
  if not public.is_admin() then raise exception 'Admins only'; end if;
  if not exists (select 1 from public.profiles where id = p_id) then raise exception 'User not found'; end if;
  if uname !~ '^[a-z0-9._-]{3,30}$' then raise exception 'Username: 3-30 chars, letters/numbers . _ -'; end if;
  if btrim(coalesce(p_name,'')) = '' then raise exception 'Name is required'; end if;
  if p_role not in ('admin','staff') then raise exception 'Invalid role'; end if;
  if p_id = auth.uid() and p_role <> 'admin' then raise exception 'You cannot remove your own admin role'; end if;
  if p_password is not null and p_password <> '' and char_length(p_password) < 6 then
    raise exception 'Password must be at least 6 characters';
  end if;
  if exists (select 1 from public.profiles where username = uname and id <> p_id) then
    raise exception 'Username taken';
  end if;

  update public.profiles set username = uname, name = btrim(p_name), role = p_role where id = p_id;

  update auth.users set email = mail, updated_at = now() where id = p_id;
  update auth.identities
     set identity_data = jsonb_set(identity_data, '{email}', to_jsonb(mail)), updated_at = now()
   where user_id = p_id and provider = 'email';

  if p_password is not null and p_password <> '' then
    update auth.users set encrypted_password = extensions.crypt(p_password, extensions.gen_salt('bf')) where id = p_id;
  end if;

  -- keep the denormalised name on bookings in sync
  update public.bookings set assigned_name = btrim(p_name) where assigned_to = p_id;
end $$;

create or replace function public.delete_staff_user(p_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'Admins only'; end if;
  if p_id = auth.uid() then raise exception 'You cannot delete yourself'; end if;
  if not exists (select 1 from public.profiles where id = p_id) then raise exception 'User not found'; end if;
  -- profile, sessions and identities cascade; bookings they were assigned to become unassigned
  update public.bookings set assigned_to = null, assigned_name = null where assigned_to = p_id;
  delete from auth.users where id = p_id;
end $$;

revoke all on function public.update_staff_user(uuid,text,text,text,text), public.delete_staff_user(uuid) from public, anon;
grant execute on function public.update_staff_user(uuid,text,text,text,text), public.delete_staff_user(uuid) to authenticated;
