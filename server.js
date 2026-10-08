const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const PORT = process.env.PORT || 3000;
const SLOTS = [1, 2];
const STATUSES = ['received', 'working', 'approval', 'rejected', 'completed'];
const ROLES = ['admin', 'staff', 'requester'];
const HORIZON_YEARS = 5;

fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
const db = new DatabaseSync(path.join(__dirname, 'data', 'javacontent.db'));
db.exec(`
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','staff','requester')),
  password_hash TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slot_date TEXT NOT NULL,
  slot_no INTEGER NOT NULL CHECK (slot_no IN (1,2)),
  requirement TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'received',
  requested_by INTEGER NOT NULL REFERENCES users(id),
  assigned_to INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (slot_date, slot_no)
);
CREATE TABLE IF NOT EXISTS status_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id INTEGER NOT NULL REFERENCES bookings(id),
  status TEXT NOT NULL,
  note TEXT,
  changed_by INTEGER NOT NULL REFERENCES users(id),
  changed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`);

// ---------- helpers ----------
const hash = (pw) => {
  const salt = crypto.randomBytes(16).toString('hex');
  return `${salt}:${crypto.scryptSync(pw, salt, 64).toString('hex')}`;
};
const verify = (pw, stored) => {
  const [salt, h] = stored.split(':');
  const a = Buffer.from(h, 'hex');
  const b = crypto.scryptSync(pw, salt, 64);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};
const iso = (d) => d.toISOString().slice(0, 10);
const today = () => {
  const d = new Date();
  return iso(new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())));
};
const maxDate = () => {
  const d = new Date(today() + 'T00:00:00Z');
  d.setUTCFullYear(d.getUTCFullYear() + HORIZON_YEARS);
  return iso(d);
};
const validDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && iso(new Date(s + 'T00:00:00Z')) === s;
const publicUser = (u) => ({ id: u.id, username: u.username, name: u.name, role: u.role, active: !!u.active });
const isStaff = (u) => u.role === 'admin' || u.role === 'staff';

if (!db.prepare('SELECT 1 FROM users LIMIT 1').get()) {
  const pw = process.env.ADMIN_PASSWORD || 'admin123';
  db.prepare('INSERT INTO users (username,name,role,password_hash) VALUES (?,?,?,?)')
    .run('admin', 'Administrator', 'admin', hash(pw));
  console.log(`Seeded admin user "admin" (password: ${process.env.ADMIN_PASSWORD ? '[from ADMIN_PASSWORD]' : 'admin123'}). Change it!`);
}

const BOOKING_SQL = `
SELECT b.id, b.slot_date, b.slot_no, b.requirement, b.status, b.created_at, b.updated_at,
       b.requested_by, r.name AS requested_by_name, b.assigned_to, a.name AS assigned_to_name
FROM bookings b
JOIN users r ON r.id = b.requested_by
LEFT JOIN users a ON a.id = b.assigned_to`;

// ---------- app ----------
const app = express();
app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const auth = (roles) => (req, res, next) => {
  const token = (req.headers.authorization || '').replace(/^Bearer /, '');
  const u = token && db.prepare(
    'SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND u.active = 1').get(token);
  if (!u) return res.status(401).json({ error: 'Please sign in' });
  if (roles && !roles.includes(u.role)) return res.status(403).json({ error: 'Not allowed' });
  req.user = u;
  req.token = token;
  next();
};

function startSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token,user_id) VALUES (?,?)').run(token, userId);
  return token;
}

function checkNewUser({ username, name, password }) {
  const un = String(username || '').trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,30}$/.test(un)) return { error: 'Username: 3-30 chars, letters/numbers . _ -' };
  if (!String(name || '').trim()) return { error: 'Name is required' };
  if (String(password || '').length < 6) return { error: 'Password must be at least 6 characters' };
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(un)) return { error: 'Username taken', status: 409 };
  return { un };
}

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE username = ? AND active = 1')
    .get(String(username || '').trim().toLowerCase());
  if (!u || !verify(String(password || ''), u.password_hash))
    return res.status(401).json({ error: 'Wrong username or password' });
  res.json({ token: startSession(u.id), user: publicUser(u) });
});

app.post('/api/signup', (req, res) => {
  const c = checkNewUser(req.body || {});
  if (c.error) return res.status(c.status || 400).json({ error: c.error });
  const r = db.prepare('INSERT INTO users (username,name,role,password_hash) VALUES (?,?,?,?)')
    .run(c.un, String(req.body.name).trim(), 'requester', hash(req.body.password));
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(r.lastInsertRowid);
  res.json({ token: startSession(u.id), user: publicUser(u) });
});

app.post('/api/logout', auth(), (req, res) => {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(req.token);
  res.json({ ok: true });
});

app.get('/api/me', auth(), (req, res) =>
  res.json({ user: publicUser(req.user), statuses: STATUSES, minDate: today(), maxDate: maxDate() }));

// Calendar: booked slots for a month (any signed-in user sees what's taken)
app.get('/api/calendar', auth(), (req, res) => {
  const m = String(req.query.month || '');
  if (!/^\d{4}-\d{2}$/.test(m)) return res.status(400).json({ error: 'month=YYYY-MM required' });
  const rows = db.prepare(`${BOOKING_SQL} WHERE b.slot_date LIKE ? ORDER BY b.slot_date, b.slot_no`).all(m + '-%');
  res.json({
    min: today(),
    max: maxDate(),
    bookings: rows.map((b) => ({
      id: b.id, slot_date: b.slot_date, slot_no: b.slot_no, status: b.status,
      mine: b.requested_by === req.user.id,
      requested_by_name: b.requested_by_name,
      requirement: isStaff(req.user) || b.requested_by === req.user.id ? b.requirement : undefined,
    })),
  });
});

app.post('/api/bookings', auth(), (req, res) => {
  const { slot_date, slot_no, requirement } = req.body || {};
  const no = Number(slot_no);
  if (!validDate(slot_date)) return res.status(400).json({ error: 'Invalid date' });
  if (!SLOTS.includes(no)) return res.status(400).json({ error: 'Slot must be 1 or 2' });
  if (slot_date < today() || slot_date > maxDate())
    return res.status(400).json({ error: 'Date is outside the bookable range' });
  const text = String(requirement || '').trim();
  if (text.length < 3 || text.length > 4000)
    return res.status(400).json({ error: 'Describe the requirement (3-4000 chars)' });
  try {
    const r = db.prepare('INSERT INTO bookings (slot_date,slot_no,requirement,requested_by) VALUES (?,?,?,?)')
      .run(slot_date, no, text, req.user.id);
    db.prepare('INSERT INTO status_history (booking_id,status,note,changed_by) VALUES (?,?,?,?)')
      .run(r.lastInsertRowid, 'received', 'Booking created', req.user.id);
    res.json({ id: Number(r.lastInsertRowid) });
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return res.status(409).json({ error: 'That slot was just taken' });
    throw e;
  }
});

// Staff see all (filterable); requesters see their own
app.get('/api/bookings', auth(), (req, res) => {
  const where = [], args = [];
  if (!isStaff(req.user)) {
    where.push('b.requested_by = ?');
    args.push(req.user.id);
  } else {
    if (STATUSES.includes(req.query.status)) { where.push('b.status = ?'); args.push(req.query.status); }
    if (req.query.assigned === 'me') { where.push('b.assigned_to = ?'); args.push(req.user.id); }
    else if (req.query.assigned === 'none') where.push('b.assigned_to IS NULL');
  }
  const sql = `${BOOKING_SQL} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY b.slot_date, b.slot_no LIMIT 500`;
  res.json({ bookings: db.prepare(sql).all(...args) });
});

app.get('/api/bookings/:id', auth(), (req, res) => {
  const b = db.prepare(`${BOOKING_SQL} WHERE b.id = ?`).get(req.params.id);
  if (!b || (!isStaff(req.user) && b.requested_by !== req.user.id)) return res.status(404).json({ error: 'Not found' });
  const history = db.prepare(`SELECT h.status,h.note,h.changed_at,u.name AS changed_by_name
    FROM status_history h JOIN users u ON u.id = h.changed_by WHERE h.booking_id = ? ORDER BY h.id`).all(b.id);
  res.json({ booking: b, history });
});

// Staff: update status / assignee
app.patch('/api/bookings/:id', auth(['admin', 'staff']), (req, res) => {
  const b = db.prepare('SELECT * FROM bookings WHERE id = ?').get(req.params.id);
  if (!b) return res.status(404).json({ error: 'Not found' });
  const { status, assigned_to, note } = req.body || {};
  if (status !== undefined && !STATUSES.includes(status)) return res.status(400).json({ error: 'Invalid status' });
  let assignee = b.assigned_to;
  if (assigned_to !== undefined) {
    if (assigned_to === null || assigned_to === '') assignee = null;
    else {
      const a = db.prepare("SELECT id FROM users WHERE id = ? AND active = 1 AND role IN ('admin','staff')").get(assigned_to);
      if (!a) return res.status(400).json({ error: 'Assignee must be an active staff user' });
      assignee = a.id;
    }
  }
  const newStatus = status ?? b.status;
  db.prepare('UPDATE bookings SET status=?, assigned_to=?, updated_at=CURRENT_TIMESTAMP WHERE id=?')
    .run(newStatus, assignee, b.id);
  if (newStatus !== b.status || note) {
    db.prepare('INSERT INTO status_history (booking_id,status,note,changed_by) VALUES (?,?,?,?)')
      .run(b.id, newStatus, String(note || '').slice(0, 1000) || null, req.user.id);
  }
  res.json({ ok: true });
});

// Requesters may cancel their own booking while it is still "received"
app.delete('/api/bookings/:id', auth(), (req, res) => {
  const b = db.prepare('SELECT * FROM bookings WHERE id = ?').get(req.params.id);
  if (!b) return res.status(404).json({ error: 'Not found' });
  if (!isStaff(req.user) && (b.requested_by !== req.user.id || b.status !== 'received'))
    return res.status(403).json({ error: 'Only your own bookings still in "received" can be cancelled' });
  db.prepare('DELETE FROM status_history WHERE booking_id = ?').run(b.id);
  db.prepare('DELETE FROM bookings WHERE id = ?').run(b.id);
  res.json({ ok: true });
});

// Users: admin manages; staff can list backend users for assignment
app.get('/api/users', auth(['admin', 'staff']), (req, res) => {
  const rows = db.prepare('SELECT * FROM users ORDER BY role, name').all();
  res.json({
    users: req.user.role === 'admin'
      ? rows.map(publicUser)
      : rows.filter((u) => u.role !== 'requester' && u.active).map(publicUser),
  });
});

app.post('/api/users', auth(['admin']), (req, res) => {
  const c = checkNewUser(req.body || {});
  if (c.error) return res.status(c.status || 400).json({ error: c.error });
  if (!ROLES.includes(req.body.role)) return res.status(400).json({ error: 'Invalid role' });
  const r = db.prepare('INSERT INTO users (username,name,role,password_hash) VALUES (?,?,?,?)')
    .run(c.un, String(req.body.name).trim(), req.body.role, hash(req.body.password));
  res.json({ id: Number(r.lastInsertRowid) });
});

app.patch('/api/users/:id', auth(['admin']), (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!u) return res.status(404).json({ error: 'Not found' });
  const { active, password, role } = req.body || {};
  if (u.id === req.user.id && (active === false || (role && role !== 'admin')))
    return res.status(400).json({ error: "You can't deactivate or demote yourself" });
  if (role !== undefined && !ROLES.includes(role)) return res.status(400).json({ error: 'Invalid role' });
  if (password !== undefined && String(password).length < 6)
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  db.prepare('UPDATE users SET active=?, role=?, password_hash=? WHERE id=?').run(
    active === undefined ? u.active : active ? 1 : 0,
    role ?? u.role,
    password !== undefined ? hash(String(password)) : u.password_hash,
    u.id);
  if (active === false || password !== undefined) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
  res.json({ ok: true });
});

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, next) => { console.error(err); res.status(500).json({ error: 'Server error' }); });

app.listen(PORT, () => console.log(`Java Lounge content booking running on http://localhost:${PORT}`));
