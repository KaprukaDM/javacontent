-- Adds the branch (outlet) field to bookings. Run in the Supabase SQL Editor. Safe to re-run.
-- Existing bookings keep an empty branch; new bookings must supply one.

alter table public.bookings add column if not exists branch text
  check (branch is null or char_length(btrim(branch)) between 2 and 60);

drop policy if exists bookings_insert on public.bookings;
create policy bookings_insert on public.bookings for insert to anon, authenticated
  with check (
    status = 'received' and assigned_to is null and assigned_name is null
    and branch is not null
    and slot_date >= (now() at time zone 'Asia/Colombo')::date
    and slot_date <= (now() at time zone 'Asia/Colombo')::date + interval '5 years'
  );

grant insert (slot_date, slot_no, requester_name, branch, requirement) on public.bookings to anon, authenticated;
