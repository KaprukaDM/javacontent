# javacontent

Content booking system for [Java Lounge](https://javalounge.lk/). Two slots per day, bookable up to 5 years ahead.
Anyone can book a slot and type the post requirement; the backend team manages it and the status syncs back.

**Statuses:** received → working → approval → rejected / completed

Static site (GitHub Pages) + Supabase (Postgres, Auth, row level security). No server to run.

## Pages
- `/` – branch sign-in, then the booking calendar. Each outlet has its own login; the branch is filled in automatically. Branches see which slots are taken (and by which branch) but only open their own bookings.
- `/admin/` – backend login (admin / staff). Calendar with key occasions, Work board (status, assign), and for admins a Users tab: create, edit, reset password, disable, delete.

## One-time Supabase setup
Supabase dashboard → **SQL Editor**. Run these files in order:
1. [`supabase/setup.sql`](supabase/setup.sql)
2. [`supabase/user_management.sql`](supabase/user_management.sql)
3. [`supabase/add_branch.sql`](supabase/add_branch.sql)
4. [`supabase/lead_time.sql`](supabase/lead_time.sql)
5. [`supabase/branch_accounts.sql`](supabase/branch_accounts.sql)

Then:
- Edit the password in [`supabase/seed_admin.sql`](supabase/seed_admin.sql) (don't commit it) and run it to create the first admin.
- Run `select * from public.seed_branch_users();` to create the 20 branch logins. Copy the usernames and passwords it returns; they can't be shown again (admin can reset any of them in the Users tab).
- Authentication → Sign In / Providers: turn **off** "Confirm email" and **off** "Allow new users to sign up".

## Hosting
GitHub → Settings → Pages → Source: *Deploy from a branch*, branch `main`, folder `/docs`.

The Supabase URL and publishable key in `docs/config.js` are public by design; access is limited by the row level security policies in `setup.sql`. Never commit the database password or a `service_role` key.

Created by Fari Akthar - 207 | Kapruka Holdings PLC
