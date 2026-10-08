const $ = (s) => document.querySelector(s);
const app = $('#app'), nav = $('#nav'), who = $('#who');
const STATUSES = ['received', 'working', 'approval', 'rejected', 'completed'];
const ADMIN = !!window.JL_ADMIN;
const sb = supabase.createClient(JL_CONFIG.url, JL_CONFIG.key);
const MAIL_DOMAIN = '@javalounge.app';
const BRANCHES = {
  'Colombo': ['Bambalapitiya', 'Barnes Place', 'Colombo 01 (Fort)', 'Jawattha', 'Mount Lavinia', 'Nawala', 'Nugegoda', 'Pelawatta', 'Weli Park'],
  'Kandy': ['Kandy', 'Peradeniya'],
  'Other Cities': ['Ambuluwawa', 'Weligama'],
  'Other Outlets': ['Battaramulla', 'Gamsaba Junction', 'Kelaniya (Kiribathgoda)', 'Makumbura (Kottawa)', 'Negombo', 'Piliyandala', 'Wellawatte'],
};
const branchOptions = (sel) => `<option value="">Select branch…</option>` + Object.entries(BRANCHES).map(([g, l]) =>
  `<optgroup label="${g}">${l.map((b) => `<option ${b === sel ? 'selected' : ''}>${esc(b)}</option>`).join('')}</optgroup>`).join('');
const branchChecks = (locked) => Object.entries(BRANCHES).map(([g, l]) =>
  `<div class="bgroup"><b>${g}</b><div class="bchecks">${l.map((b) => `<label class="chk"><input type="checkbox" name="branches" value="${esc(b)}" ${b === locked ? 'checked disabled' : ''}> ${esc(b)}</label>`).join('')}</div></div>`).join('');
const branchList = (b) => (b.branches && b.branches.length ? b.branches : b.branch ? [b.branch] : []);
let me = null, view = 'calendar', month = null, staffList = [];

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const chip = (s) => `<span class="chip s-${esc(s)}">${esc(s)}</span>`;
const fmtDate = (d) => new Date(d + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' });
const fmtTime = (t) => new Date(t).toLocaleString();
const pad = (n) => String(n).padStart(2, '0');

// Sri Lanka "today" and the 5-year horizon (matches the database rule)
const MIN_DATE = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Colombo' });
const MAX_DATE = (() => { const [y, m, d] = MIN_DATE.split('-').map(Number); return `${y + 5}-${pad(m)}-${pad(d)}`; })();

// Public bookings open LEAD_DAYS after today (time to prepare); signed-in staff can book from today.
const LEAD_DAYS = 3;
const addDays = (d, n) => { const t = new Date(d + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const BOOK_FROM = addDays(MIN_DATE, LEAD_DAYS);

// ---------- key occasions (shown on the admin calendar to plan content) ----------
// nth weekday of a month: wd 0=Sun..6=Sat, n=1..5 (m0 is 0-based). Returns the day of month.
const nthWeekday = (y, m0, wd, n) => 1 + ((wd - new Date(Date.UTC(y, m0, 1)).getUTCDay() + 7) % 7) + 7 * (n - 1);
const OCCASIONS = [
  { name: "New Year's Day", icon: '🎆', md: '01-01' },
  { name: 'Independence Day', icon: '🇱🇰', md: '02-04' },
  { name: "Valentine's Day", icon: '❤️', md: '02-14' },
  { name: "Women's Day", icon: '🌸', md: '03-08' },
  { name: 'Avurudu Eve', icon: '🪔', md: '04-13' },
  { name: 'Sinhala & Tamil New Year', icon: '🪔', md: '04-14' },
  { name: "Mother's Day", icon: '💐', calc: (y) => [4, nthWeekday(y, 4, 0, 2)] },
  { name: "Father's Day", icon: '👔', calc: (y) => [5, nthWeekday(y, 5, 0, 3)] },
  { name: 'World Chocolate Day', icon: '🍫', md: '07-07' },
  { name: 'Friendship Day', icon: '🤝', calc: (y) => [7, nthWeekday(y, 7, 0, 1)] },
  { name: 'International Coffee Day', icon: '☕', md: '10-01' },
  { name: "Children's Day", icon: '🧒', md: '10-01' },
  { name: 'Halloween', icon: '🎃', md: '10-31' },
  { name: 'Black Friday', icon: '🛍️', calc: (y) => [10, nthWeekday(y, 10, 4, 4) + 1] },
  { name: 'Christmas Eve', icon: '🎅', md: '12-24' },
  { name: 'Christmas Day', icon: '🎄', md: '12-25' },
  { name: "New Year's Eve", icon: '🥂', md: '12-31' },
];
const occCache = {};
function occasionsFor(date) {
  const y = +date.slice(0, 4);
  if (!occCache[y]) {
    const map = {};
    OCCASIONS.forEach((o) => {
      const [m0, d] = o.calc ? o.calc(y) : [+o.md.slice(0, 2) - 1, +o.md.slice(3)];
      const key = `${y}-${pad(m0 + 1)}-${pad(d)}`;
      (map[key] = map[key] || []).push(o);
    });
    occCache[y] = map;
  }
  return occCache[y][date] || [];
}

function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), 2800);
}
function openModal(html) { $('#sheet').innerHTML = html; $('#modal').hidden = false; }
function closeModal() { $('#modal').hidden = true; }
$('#modal').addEventListener('mousedown', (e) => { if (e.target.id === 'modal') closeModal(); });
const must = ({ data, error }) => { if (error) throw new Error(error.message); return data; };

// ---------- sign-in: branches on "/", backend staff on "/admin/" ----------
const isStaff = () => !!me && me.role !== 'branch';
const isBranch = () => !!me && me.role === 'branch';
let denyReason = '';
async function signOut() {
  await sb.auth.signOut();
  me = null; view = 'calendar'; renderChrome(); render();
}
function loginPage() {
  nav.innerHTML = '';
  who.innerHTML = '';
  document.body.classList.add('login-screen');
  app.innerHTML = `<div class="card auth"><h2>${ADMIN ? 'Backend sign in' : 'Sign in'}</h2>
    <p style="margin-top:0">${ADMIN ? 'Java Lounge content team' : 'Branches and the Java Lounge team: sign in to book content slots.'}</p><form id="lf">
    <label>Username</label><input name="username" autocomplete="username" required>
    <label>Password</label><input name="password" type="password" autocomplete="current-password" required>
    <div class="err" id="le"></div>
    <button class="btn" style="width:100%;margin-top:12px">Sign in</button></form></div>`;
  $('#lf').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const { error } = await sb.auth.signInWithPassword({
      email: String(fd.get('username')).trim().toLowerCase() + MAIL_DOMAIN, password: fd.get('password') });
    if (error) return ($('#le').textContent = 'Wrong username or password');
    if (!(await loadMe())) { await sb.auth.signOut(); return ($('#le').textContent = denyReason || 'This account is not active'); }
    boot();
  };
}
async function loadMe() {
  denyReason = '';
  const { data: s } = await sb.auth.getSession();
  if (!s.session) return (me = null);
  const { data } = await sb.from('profiles').select('*').eq('id', s.session.user.id).maybeSingle();
  me = data && data.active ? data : null;
  if (me && ADMIN && me.role === 'branch') { me = null; denyReason = 'Branch logins sign in on the main booking page, not the backend.'; }
  if (me && isStaff()) {
    staffList = (await sb.from('profiles').select('id,name,role,active').eq('active', true).in('role', ['admin', 'staff']).order('name')).data || [];
  }
  return me;
}
async function boot() {
  await loadMe();
  view = ADMIN && me ? 'board' : 'calendar';
  renderChrome();
  render();
}
const isTyping = () => ['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName);

function renderChrome() {
  document.body.classList.toggle('login-screen', !me);
  nav.hidden = who.hidden = false;
  nav.innerHTML = '';
  if (isStaff()) {
    // two top-level destinations for backend users: the booking front end and the backend
    nav.innerHTML = `<a class="navlink ${ADMIN ? '' : 'on'}" href="${ADMIN ? '../' : './'}">Front end</a>
      <a class="navlink ${ADMIN ? 'on' : ''}" href="${ADMIN ? './' : 'admin/'}">Backend</a>`;
  }
  if (ADMIN && me) {
    const tabs = [['calendar', 'Calendar'], ['board', 'Work board']];
    if (me.role === 'admin') tabs.push(['users', 'Users']);
    nav.innerHTML += `<span class="navsep"></span>` + tabs.map(([k, l]) => `<button data-v="${k}" class="${view === k ? 'on' : ''}">${l}</button>`).join('');
    nav.querySelectorAll('button').forEach((b) => (b.onclick = () => { view = b.dataset.v; renderChrome(); render(); }));
  }
  who.innerHTML = me
    ? `${esc(isBranch() ? me.branch : me.name)} <span class="chip">${esc(me.role)}</span><button class="btn sm alt" id="out">Sign out</button>` : '';
  if (me) $('#out').onclick = signOut;
}
function render(quiet) {
  if (!me) return loginPage();
  document.body.classList.remove('login-screen');
  const fn = { calendar: renderCalendar, board: renderBoard, users: renderUsers }[view];
  fn(quiet).catch((e) => { if (!quiet) toast(e.message); });
}
setInterval(() => { if (me && $('#modal').hidden && !document.hidden && !isTyping()) render(true); }, 10000);

// ---------- calendar ----------
// First month that still has a free slot we are allowed to book (opens the calendar on the right month).
async function firstOpenMonth() {
  const start = isStaff() ? MIN_DATE : BOOK_FROM;
  try {
    const rows = must(await sb.from('calendar_slots').select('slot_date').gte('slot_date', start).order('slot_date').limit(1000));
    const taken = {};
    rows.forEach((r) => (taken[r.slot_date] = (taken[r.slot_date] || 0) + 1));
    for (let d = start, i = 0; d <= MAX_DATE && i < 1100; d = addDays(d, 1), i++) {
      if ((taken[d] || 0) < 2) return d.slice(0, 7);
    }
  } catch { /* fall back below */ }
  return start.slice(0, 7);
}

async function renderCalendar() {
  month = month || (await firstOpenMonth());
  const [y, m] = month.split('-').map(Number);
  const first = new Date(y, m - 1, 1), days = new Date(y, m, 0).getDate();
  const rows = must(await sb.from('calendar_slots').select('id,slot_date,slot_no,status,branch,branches,mine,requester_name')
    .gte('slot_date', `${month}-01`).lte('slot_date', `${month}-${pad(days)}`));
  const by = {};
  rows.forEach((b) => (by[b.slot_date + '|' + b.slot_no] = b));
  let cells = '';
  for (let i = 0; i < first.getDay(); i++) cells += '<div class="day pad"></div>';
  for (let d = 1; d <= days; d++) {
    const date = `${month}-${pad(d)}`;
    const past = date < MIN_DATE, out = date > MAX_DATE, blocked = !past && date < BOOK_FROM, closed = blocked && !isStaff();
    const slots = [1, 2].map((n) => {
      const b = by[date + '|' + n];
      const bl = b ? branchList(b) : [];
      const label = b && ((bl[0] || b.requester_name || 'Booked') + (bl.length > 1 ? ` +${bl.length - 1}` : ''));
      if (b) return `<button class="slot booked ${b.mine ? 'mine' : ''}" ${b.mine ? `data-id="${b.id}"` : 'disabled'} title="${esc(bl.join(', ') || label)} · ${b.status}"><span class="dot d-${b.status}"></span>S${n} · ${esc(label)}</button>`;
      return `<button class="slot ${blocked ? 's-closed' : 's-free'}" data-date="${date}" data-n="${n}" ${past || out || closed ? 'disabled' : ''}>S${n} · ${blocked ? (closed ? 'Closed' : 'Staff only') : 'Free'}</button>`;
    }).join('');
    const occ = isStaff() ? occasionsFor(date) : [];
    cells += `<div class="day ${past ? 'past' : ''} ${blocked ? 'closed' : ''} ${date === MIN_DATE ? 'today' : ''} ${occ.length ? 'has-occ' : ''}"><span class="n">${d}</span>${occ.map((o) => `<span class="occ" title="${esc(o.name)}">${o.icon} ${esc(o.name)}</span>`).join('')}${out ? '' : slots}</div>`;
  }
  app.innerHTML = `
    ${ADMIN ? '' : `<div class="hello"><b>☕ Book your content slot${isBranch() ? ` · ${esc(me.branch)}` : ''}</b>Pick a free slot, tell us what you need posted, and we’ll get brewing. Bookings open from ${fmtDate(BOOK_FROM)} so we have time to prepare. ${isBranch() ? 'Click your own bookings to see their status.' : 'You are signed in as backend, so you can book for any branch and manage every booking.'}</div>`}
    <div class="bar">
      <button class="btn alt" id="prev">&larr;</button>
      <h2>${first.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</h2>
      <button class="btn alt" id="next">&rarr;</button>
      <input type="month" id="jump" value="${month}" min="${MIN_DATE.slice(0, 7)}" max="${MAX_DATE.slice(0, 7)}">
      <span class="spacer"></span>
      <span style="font-weight:600">2 slots per day · open until ${fmtDate(MAX_DATE)}</span>
    </div>
    <div class="legend">${['free', ...STATUSES].map(chip).join('')}</div>
    <div class="cal">${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => `<div class="dow">${d}</div>`).join('')}${cells}</div>`;
  const shift = (n) => {
    const d = new Date(y, m - 1 + n, 1), v = `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
    if (v >= MIN_DATE.slice(0, 7) && v <= MAX_DATE.slice(0, 7)) { month = v; render(); }
  };
  $('#prev').onclick = () => shift(-1);
  $('#next').onclick = () => shift(1);
  $('#jump').onchange = (e) => { if (e.target.value) { month = e.target.value; render(); } };
  app.querySelectorAll('.slot[data-date]').forEach((b) => (b.onclick = () => bookDialog(b.dataset.date, +b.dataset.n)));
  app.querySelectorAll('.slot[data-id]').forEach((b) => (b.onclick = () => detailDialog(b.dataset.id)));
}

function bookDialog(date, n) {
  openModal(`<h3>Book ${fmtDate(date)} · Slot ${n}</h3>
    <form id="bf">
    <label style="margin-top:0">${isBranch() ? `Branches (yours, <b>${esc(me.branch)}</b>, is included — tick any others)` : 'Branches (tick one or more)'}</label>
    <div class="bpick">${branchChecks(isBranch() ? me.branch : '')}</div>
    <label>What do you need posted?</label>
    <textarea name="requirement" maxlength="4000" placeholder="Describe the post requirement…" required></textarea>
    <div class="err" id="be"></div>
    <div class="row"><button type="button" class="btn alt" id="cx">Cancel</button><button class="btn">Book slot</button></div></form>`);
  $('#cx').onclick = closeModal;
  $('#bf').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const picked = fd.getAll('branches');
    const branches = isBranch() ? [me.branch, ...picked.filter((x) => x !== me.branch)] : picked;
    if (!branches.length) return ($('#be').textContent = 'Tick at least one branch');
    const { error } = await sb.from('bookings').insert({
      slot_date: date, slot_no: n,
      requester_name: isBranch() ? me.branch : me.name, branch: branches[0], branches, requirement: String(fd.get('requirement')).trim() });
    if (error) {
      $('#be').textContent = error.code === '23505' ? 'That slot was just taken' : 'Could not book this slot. Check the branch and requirement.';
      if (error.code === '23505') render();
      return;
    }
    closeModal(); toast('Slot booked'); render();
  };
}

async function detailDialog(id) {
  const b = must(await sb.from('bookings').select('*').eq('id', id).single());
  const history = must(await sb.from('status_history').select('*').eq('booking_id', id).order('id'));
  openModal(`<h3>${fmtDate(b.slot_date)} · Slot ${b.slot_no}</h3>
    <p>${chip(b.status)} &nbsp; for <b>${esc(branchList(b).join(', ') || b.requester_name)}</b>${b.requester_name && !branchList(b).includes(b.requester_name) ? ` · booked by ${esc(b.requester_name)}` : ''} · assigned: <b>${esc(b.assigned_name || 'nobody yet')}</b></p>
    <div class="req-text">${esc(b.requirement)}</div>
    ${isStaff() ? `<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px">
      <div><label>Status</label><select id="d-status">${STATUSES.map((s) => `<option ${s === b.status ? 'selected' : ''}>${s}</option>`).join('')}</select></div>
      <div><label>Assigned to</label><select id="d-assign"><option value="">— unassigned —</option>${staffList.map((u) => `<option value="${u.id}" ${u.id === b.assigned_to ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}</select></div>
    </div>` : ''}
    <b>History</b><ul class="hist">${history.map((h) => `<li>${chip(h.status)} ${esc(h.changed_by_name)} · ${esc(fmtTime(h.changed_at))}</li>`).join('')}</ul>
    <div class="row">${isStaff() ? '<button class="btn danger" id="del">Cancel booking</button>' : ''}<button class="btn alt" id="cx">Close</button></div>`);
  $('#cx').onclick = closeModal;
  if (isStaff()) {
    const save = async (patch) => {
      try {
        must(await sb.from('bookings').update(patch).eq('id', id));
        toast('Updated');
        render(true);          // refresh the calendar/board behind the popup
        await detailDialog(id); // reload the popup in place (new status, assignee, history)
      } catch (e) { toast(e.message); }
    };
    $('#d-status').onchange = (e) => save({ status: e.target.value });
    $('#d-assign').onchange = (e) => save({ assigned_to: e.target.value || null });
  }
  if (isStaff()) $('#del').onclick = async () => {
    if (!confirm('Cancel this booking and free the slot?')) return;
    try { must(await sb.from('bookings').delete().eq('id', id)); closeModal(); toast('Booking cancelled'); render(); } catch (e) { toast(e.message); }
  };
}

// ---------- work board (staff) ----------
async function renderBoard() {
  const f = renderBoard.f || (renderBoard.f = { status: '', assigned: '' });
  let q = sb.from('bookings').select('*').order('slot_date').order('slot_no').limit(500);
  if (f.status) q = q.eq('status', f.status);
  if (f.assigned === 'me') q = q.eq('assigned_to', me.id);
  if (f.assigned === 'none') q = q.is('assigned_to', null);
  const bookings = must(await q);
  const keepScroll = window.scrollY;
  const rows = bookings.map((b) => `<tr>
    <td><b>${fmtDate(b.slot_date)}</b><br>Slot ${b.slot_no}</td>
    <td>${branchList(b).length ? esc(branchList(b).join(', ')) : esc(b.requester_name)}${b.requester_name && !branchList(b).includes(b.requester_name) ? `<br><small>by ${esc(b.requester_name)}</small>` : ''}</td>
    <td class="req">${esc(b.requirement)}</td>
    <td><select data-id="${b.id}" data-f="status">${STATUSES.map((s) => `<option ${s === b.status ? 'selected' : ''}>${s}</option>`).join('')}</select></td>
    <td><select data-id="${b.id}" data-f="assigned_to"><option value="">— unassigned —</option>${staffList.map((u) => `<option value="${u.id}" ${u.id === b.assigned_to ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}</select></td>
    <td><button class="btn sm alt" data-open="${b.id}">Details</button></td></tr>`).join('');
  app.innerHTML = `
    <div class="bar"><h2 style="text-align:left">Work board</h2><span class="spacer"></span>
      <select id="fs"><option value="">All statuses</option>${STATUSES.map((s) => `<option ${f.status === s ? 'selected' : ''}>${s}</option>`).join('')}</select>
      <select id="fa"><option value="">Anyone</option><option value="me" ${f.assigned === 'me' ? 'selected' : ''}>Assigned to me</option><option value="none" ${f.assigned === 'none' ? 'selected' : ''}>Unassigned</option></select>
    </div>
    ${bookings.length ? `<div class="tablewrap"><table><thead><tr><th>Slot</th><th>Branch(es)</th><th>Requirement</th><th>Status</th><th>Assigned</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`
      : '<div class="card empty">No bookings match.</div>'}`;
  window.scrollTo(0, keepScroll);
  $('#fs').onchange = (e) => { f.status = e.target.value; render(); };
  $('#fa').onchange = (e) => { f.assigned = e.target.value; render(); };
  app.querySelectorAll('select[data-id]').forEach((s) => (s.onchange = async () => {
    const patch = s.dataset.f === 'assigned_to' ? { assigned_to: s.value || null } : { status: s.value };
    try { must(await sb.from('bookings').update(patch).eq('id', s.dataset.id)); toast('Updated'); }
    catch (e) { toast(e.message); render(); }
  }));
  app.querySelectorAll('[data-open]').forEach((b) => (b.onclick = () => detailDialog(b.dataset.open)));
}

// ---------- users (admin) ----------
async function renderUsers() {
  if (me?.role !== 'admin') return;
  const users = must(await sb.from('profiles').select('*').order('role').order('name'));
  app.innerHTML = `
    <div class="bar"><h2 style="text-align:left">Users</h2></div>
    <form class="card" id="uf" style="margin-bottom:18px">
      <b>Create user</b>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px">
        <div><label>Name</label><input name="name" required></div>
        <div><label>Username</label><input name="username" required></div>
        <div><label>Password</label><input name="password" type="text" minlength="6" required></div>
        <div><label>Role</label><select name="role" id="nr"><option value="staff">staff (backend)</option><option value="admin">admin</option><option value="branch">branch (outlet login)</option></select></div>
        <div id="nbw" hidden><label>Branch</label><select name="branch">${branchOptions('')}</select></div>
      </div>
      <div class="err" id="ue"></div><button class="btn">Create user</button>
    </form>
    <div class="tablewrap"><table><thead><tr><th>Name</th><th>Username</th><th>Role</th><th>Branch</th><th>Status</th><th></th></tr></thead><tbody>
    ${users.map((u) => `<tr><td>${esc(u.name)}</td><td>${esc(u.username)}</td><td>${esc(u.role)}</td><td>${esc(u.branch || '')}</td><td>${u.active ? 'active' : 'disabled'}</td>
      <td><button class="btn sm alt" data-act="edit" data-id="${u.id}">Edit</button>${u.id === me.id ? '' : `
      <button class="btn sm alt" data-act="reset" data-id="${u.id}">Reset password</button>
      <button class="btn sm alt" data-act="toggle" data-id="${u.id}" data-on="${u.active ? 1 : 0}">${u.active ? 'Disable' : 'Enable'}</button>
      <button class="btn sm danger" data-act="del" data-id="${u.id}">Delete</button>`}</td></tr>`).join('')}
    </tbody></table></div>`;
  $('#nr').onchange = (e) => { $('#nbw').hidden = e.target.value !== 'branch'; };
  $('#uf').onsubmit = async (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(e.target));
    const { error } = await sb.rpc('create_staff_user', { p_username: fd.username, p_name: fd.name, p_password: fd.password, p_role: fd.role, p_branch: fd.role === 'branch' ? fd.branch || null : null });
    if (error) return ($('#ue').textContent = error.message);
    toast('User created'); await loadMe(); render();
  };
  app.querySelectorAll('[data-act]').forEach((b) => (b.onclick = async () => {
    try {
      if (b.dataset.act === 'toggle') must(await sb.rpc('set_staff_active', { p_id: b.dataset.id, p_active: b.dataset.on !== '1' }));
      else if (b.dataset.act === 'edit') return editUserDialog(users.find((u) => u.id === b.dataset.id));
      else if (b.dataset.act === 'reset') {
        const u = users.find((x) => x.id === b.dataset.id);
        if (!confirm(`Generate a new password for ${u.name} (${u.username})? The old one stops working.`)) return;
        const pw = genPassword();
        must(await sb.rpc('reset_staff_password', { p_id: u.id, p_password: pw }));
        return showCredentials(u, pw);
      }
      else {
        const u = users.find((x) => x.id === b.dataset.id);
        if (!confirm(`Delete ${u.name} (${u.username})? Their assigned bookings become unassigned. This cannot be undone.`)) return;
        must(await sb.rpc('delete_staff_user', { p_id: u.id }));
      }
      toast('Saved'); await loadMe(); render();
    } catch (e) { toast(e.message); }
  }));
}

const genPassword = () => {
  const chars = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const r = crypto.getRandomValues(new Uint32Array(10));
  return Array.from(r, (n) => chars[n % chars.length]).join('');
};
function showCredentials(u, pw) {
  openModal(`<h3>New password</h3>
    <p><b>${esc(u.name)}</b> signs in with:</p>
    <div class="req-text">Username: ${esc(u.username)}
Password: ${esc(pw)}</div>
    <p style="font-size:13px">Copy it now. It is stored hashed and can't be shown again.</p>
    <div class="row"><button class="btn alt" id="cp">Copy</button><button class="btn" id="cx">Done</button></div>`);
  $('#cx').onclick = closeModal;
  $('#cp').onclick = () => navigator.clipboard.writeText(`Username: ${u.username}
Password: ${pw}`).then(() => toast('Copied'), () => toast('Copy failed, select the text manually'));
}

function editUserDialog(u) {
  openModal(`<h3>Edit user</h3><form id="ef">
    <label>Name</label><input name="name" value="${esc(u.name)}" required>
    <label>Username</label><input name="username" value="${esc(u.username)}" required>
    <label>Role</label><select name="role"><option value="staff" ${u.role === 'staff' ? 'selected' : ''}>staff (backend)</option><option value="admin" ${u.role === 'admin' ? 'selected' : ''}>admin</option><option value="branch" ${u.role === 'branch' ? 'selected' : ''}>branch (outlet login)</option></select>
    <div id="ebw" ${u.role === 'branch' ? '' : 'hidden'}><label>Branch</label><select name="branch">${branchOptions(u.branch || '')}</select></div>
    <label>New password (leave blank to keep)</label><input name="password" type="text" minlength="6" autocomplete="off">
    <div class="err" id="ee"></div>
    <div class="row"><button type="button" class="btn alt" id="cx">Cancel</button><button class="btn">Save</button></div></form>`);
  $('#cx').onclick = closeModal;
  $('#ef').querySelector('[name=role]').onchange = (e) => { $('#ebw').hidden = e.target.value !== 'branch'; };
  $('#ef').onsubmit = async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    const { error } = await sb.rpc('update_staff_user', { p_id: u.id, p_username: f.username, p_name: f.name, p_role: f.role, p_password: f.password || null, p_branch: f.role === 'branch' ? f.branch || null : null });
    if (error) return ($('#ee').textContent = error.message);
    closeModal(); toast('User updated'); await loadMe(); render();
  };
}

boot();
