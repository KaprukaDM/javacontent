# javacontent

Content booking system for [Java Lounge](https://javalounge.lk/). Two slots per day, bookable up to 5 years ahead.
A requester picks a free slot and types the post requirement; the backend team works it and the status syncs back.

**Statuses:** received → working → approval → rejected / completed

## Run

```
npm install
npm start          # http://localhost:3000
```

Requires Node 22.13+ (uses the built-in `node:sqlite`). Set `PORT` and `ADMIN_PASSWORD` as env vars if needed.
Backend login lives at **/admin** (e.g. http://localhost:3000/admin); the public calendar at `/` has no login.
On first start an admin is seeded: `admin` / `admin123` (or `ADMIN_PASSWORD`). Change it.

## Roles
- **Public (no login)** – anyone can open the calendar, book a free slot with their name and requirement, and see live status.
- **staff** (backend, login) – work board with every booking; set status, assign to a teammate.
- **admin** – everything staff can do, plus create/disable users and reset passwords.

Pages poll every 10s so status changes appear without a refresh.

## Data
Local SQLite file at `data/javacontent.db` (git-ignored). Tables: `users`, `sessions`, `bookings`
(unique on `slot_date + slot_no`), `status_history`. Plain SQL, so it is straightforward to migrate to another database.

Created by Fari Akthar - 207 | Kapruka Holdings PLC
