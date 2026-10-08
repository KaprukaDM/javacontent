-- A booking can cover several branches. Run in the Supabase SQL Editor AFTER branch_accounts.sql. Safe to re-run.
-- bookings.branch  = the owning branch (the one that booked; first selected when staff book)
-- bookings.branches = every branch the content is for (includes the owner)
-- Every branch listed can see the booking; only the owner can have booked it.

alter table public.bookings add column if not exists branches text[];
update public.bookings set branches = array[branch] where branches is null and branch is not null;
alter table public.bookings drop constraint if exists bookings_branches_check;
alter table public.bookings add constraint bookings_branches_check
  check (branches is null or cardinality(branches) between 1 and 25);

grant insert (slot_date, slot_no, requester_name, branch, branches, requirement) on public.bookings to authenticated;

drop policy if exists bookings_read on public.bookings;
create policy bookings_read on public.bookings for select to authenticated
  using (public.is_staff() or branch = public.my_branch() or public.my_branch() = any (branches));

drop policy if exists bookings_insert on public.bookings;
create policy bookings_insert on public.bookings for insert to authenticated
  with check (
    status = 'received' and assigned_to is null and assigned_name is null
    and branch is not null and branches is not null and branch = branches[1]
    and slot_date >= (now() at time zone 'Asia/Colombo')::date
    and slot_date <= (now() at time zone 'Asia/Colombo')::date + interval '5 years'
    and (
      public.is_staff()
      or (branch = public.my_branch()
          and slot_date >= (now() at time zone 'Asia/Colombo')::date + 3)
    )
  );

create or replace view public.calendar_slots as
select b.id, b.slot_date, b.slot_no, b.status, b.branch,
       (public.is_staff() or b.branch = public.my_branch() or public.my_branch() = any (b.branches)) as mine,
       case when public.is_staff() or b.branch = public.my_branch() or public.my_branch() = any (b.branches)
            then b.requester_name end as requester_name,
       b.branches
from public.bookings b
where public.is_member();
revoke all on public.calendar_slots from public, anon;
grant select on public.calendar_slots to authenticated;

notify pgrst, 'reload schema';
