# javacontent

Content booking system for [Java Lounge](https://javalounge.lk/). Two slots per day, bookable up to 5 years ahead.
Anyone can book a slot and type the post requirement; the backend team manages it and the status syncs back.

**Statuses:** received → working → approval → rejected / completed

Static site (GitHub Pages) + Supabase (Postgres, Auth, row level security). No server to run.

## Pages
- `/` – public calendar, no login. Pick a free slot, enter your name and requirement. Status updates show live (refreshes every 10s).
- `/admin/` – backend login. Work board (set status, assign), and for admins a Users tab to create backend users.

## One-time Supabase setup
1. Supabase dashboard → **SQL Editor** → run [`supabase/setup.sql`](supabase/setup.sql), then [`supabase/user_management.sql`](supabase/user_management.sql).
2. Edit the password in [`supabase/seed_admin.sql`](supabase/seed_admin.sql) (don't commit it) and run it to create the first admin (`admin`).
3. Dashboard → Authentication → Providers → Email: turn **off** "Confirm email" and **off** public sign-ups ("Allow new users to sign up").

## Hosting
GitHub → Settings → Pages → Source: *Deploy from a branch*, branch `main`, folder `/docs`.

The Supabase URL and publishable key in `docs/config.js` are public by design; access is limited by the row level security policies in `setup.sql`. Never commit the database password or a `service_role` key.

Created by Fari Akthar - 207 | Kapruka Holdings PLC
