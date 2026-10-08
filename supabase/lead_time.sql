-- Public bookings must be at least 3 days ahead (today + the next two days are blocked).
-- Signed-in staff/admin can still book any date from today. Run in the Supabase SQL Editor. Safe to re-run.
-- To change the lead time, change the "+ 3" below (and LEAD_DAYS in docs/app.js).

drop policy if exists bookings_insert on public.bookings;
create policy bookings_insert on public.bookings for insert to anon, authenticated
  with check (
    status = 'received' and assigned_to is null and assigned_name is null
    and branch is not null
    and slot_date >= (now() at time zone 'Asia/Colombo')::date
    and slot_date <= (now() at time zone 'Asia/Colombo')::date + interval '5 years'
    and (slot_date >= (now() at time zone 'Asia/Colombo')::date + 3 or public.is_staff())
  );
