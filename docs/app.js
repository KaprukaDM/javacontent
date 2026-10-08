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

function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), 2800);
}
function openModal(html) { $('#sheet').innerHTML = html; $('#modal').hidden = false; }
function closeModal() { $('#modal').hidden = true; }
$('#modal').addEventListener('mousedown', (e) => { if (e.target.id === 'modal') closeModal(); });
const must = ({ data, error }) => { if (error) throw new Error(error.message); return data; };

// ---------- backend sign-in (only on /admin/) ----------
async function signOut() {
  await sb.auth.signOut();
  me = null; view = 'calendar'; renderChrome(); render();
}
function loginPage() {
  nav.innerHTML = '';
  app.innerHTML = `<div class="card auth"><h2>Backend sign in</h2><form id="lf">
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
    if (!(await loadMe())) { await sb.auth.signOut(); return ($('#le').textContent = 'This account is not active'); }
    boot();
  };
}
async function loadMe() {
  const { data: s } = await sb.auth.getSession();
  if (!s.session) return (me = null);
  const { data } = await sb.from('profiles').select('*').eq('id', s.session.user.id).maybeSingle();
  me = data && data.active ? data : null;
  if (me) staffList = (await sb.from('profiles').select('id,name,active').eq('active', true).order('name')).data || [];
  return me;
}
async function boot() {
  if (ADMIN) await loadMe();
  view = me ? 'board' : 'calendar';
  renderChrome();
  render();
}
const isTyping = () => ['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName);

function renderChrome() {
  if (!ADMIN) { nav.hidden = who.hidden = true; return; }
  const tabs = [['calendar', 'Calendar']];
  if (me) tabs.push(['board', 'Work board']);
  if (me?.role === 'admin') tabs.push(['users', 'Users']);
  nav.hidden = who.hidden = false;
  nav.innerHTML = me ? tabs.map(([k, l]) => `<button data-v="${k}" class="${view === k ? 'on' : ''}">${l}</button>`).join('') : '';
  nav.querySelectorAll('button').forEach((b) => (b.onclick = () => { view = b.dataset.v; renderChrome(); render(); }));
  who.innerHTML = me ? `${esc(me.name)} <span class="chip">${esc(me.role)}</span><button class="btn sm alt" id="out">Sign out</button>` : '';
  if (me) $('#out').onclick = signOut;
}
function render(quiet) {
  if (ADMIN && !me) return loginPage();
  const fn = { calendar: renderCalendar, board: renderBoard, users: renderUsers }[view];
  fn(quiet).catch((e) => { if (!quiet) toast(e.message); });
}
setInterval(() => { if ($('#modal').hidden && !document.hidden && !isTyping() && !(ADMIN && !me)) render(true); }, 10000);

// ---------- calendar ----------
async function renderCalendar() {
  month = month || MIN_DATE.slice(0, 7);
  const [y, m] = month.split('-').map(Number);
  const first = new Date(y, m - 1, 1), days = new Date(y, m, 0).getDate();
  const rows = must(await sb.from('bookings').select('id,slot_date,slot_no,status,requester_name')
    .gte('slot_date', `${month}-01`).lte('slot_date', `${month}-${pad(days)}`));
  const by = {};
  rows.forEach((b) => (by[b.slot_date + '|' + b.slot_no] = b));
  let cells = '';
  for (let i = 0; i < first.getDay(); i++) cells += '<div class="day pad"></div>';
  for (let d = 1; d <= days; d++) {
    const date = `${month}-${pad(d)}`;
    const past = date < MIN_DATE, out = date > MAX_DATE, closed = !me && !past && date < BOOK_FROM;
    const slots = [1, 2].map((n) => {
      const b = by[date + '|' + n];
      if (b) return `<button class="slot s-${b.status}" data-id="${b.id}" title="${esc(b.requester_name)} · ${b.status}">S${n} · ${esc(b.requester_name)}</button>`;
      return `<button class="slot s-free" data-date="${date}" data-n="${n}" ${past || out || closed ? 'disabled' : ''}>S${n} · ${closed ? 'Closed' : 'Free'}</button>`;
    }).join('');
    cells += `<div class="day ${past ? 'past' : ''} ${date === MIN_DATE ? 'today' : ''}"><span class="n">${d}</span>${out ? '' : slots}</div>`;
  }
  app.innerHTML = `
    ${ADMIN ? '' : '<div class="hello"><b>☕ Book your content slot</b>Pick a free slot, tell us what you need posted, and we’ll get brewing. Bookings open from ${fmtDate(BOOK_FROM)} so we have time to prepare.</div>'}
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
  const saved = me ? '' : (() => { try { return localStorage.getItem('jl_name') || ''; } catch { return ''; } })();
  const savedBranch = me ? '' : (() => { try { return localStorage.getItem('jl_branch') || ''; } catch { return ''; } })();
  openModal(`<h3>Book ${fmtDate(date)} · Slot ${n}</h3>
    <form id="bf"><label>Your name</label><input name="requester_name" value="${esc(saved)}" maxlength="80" required>
    <label>Branch</label><select name="branch" required>${branchOptions(savedBranch)}</select>
    <label>What do you need posted?</label>
    <textarea name="requirement" maxlength="4000" placeholder="Describe the post requirement…" required></textarea>
    <div class="err" id="be"></div>
    <div class="row"><button type="button" class="btn alt" id="cx">Cancel</button><button class="btn">Book slot</button></div></form>`);
  $('#cx').onclick = closeModal;
  $('#bf').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const { error } = await sb.from('bookings').insert({
      slot_date: date, slot_no: n,
      requester_name: String(fd.get('requester_name')).trim(), branch: fd.get('branch'), requirement: String(fd.get('requirement')).trim() });
    if (error) {
      $('#be').textContent = error.code === '23505' ? 'That slot was just taken' : 'Could not book this slot. Check your name and requirement.';
      if (error.code === '23505') render();
      return;
    }
    try { localStorage.setItem('jl_name', String(fd.get('requester_name')).trim()); localStorage.setItem('jl_branch', fd.get('branch')); } catch {}
    closeModal(); toast('Slot booked'); render();
  };
}

async function detailDialog(id) {
  const b = must(await sb.from('bookings').select('*').eq('id', id).single());
  const history = must(await sb.from('status_history').select('*').eq('booking_id', id).order('id'));
  openModal(`<h3>${fmtDate(b.slot_date)} · Slot ${b.slot_no}</h3>
    <p>${chip(b.status)} &nbsp; for <b>${esc(b.requester_name)}</b>${b.branch ? ` · ${esc(b.branch)}` : ''} · assigned: <b>${esc(b.assigned_name || 'nobody yet')}</b></p>
    <div class="req-text">${esc(b.requirement)}</div>
    ${me ? `<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px">
      <div><label>Status</label><select id="d-status">${STATUSES.map((s) => `<option ${s === b.status ? 'selected' : ''}>${s}</option>`).join('')}</select></div>
      <div><label>Assigned to</label><select id="d-assign"><option value="">— unassigned —</option>${staffList.map((u) => `<option value="${u.id}" ${u.id === b.assigned_to ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}</select></div>
    </div>` : ''}
    <b>History</b><ul class="hist">${history.map((h) => `<li>${chip(h.status)} ${esc(h.changed_by_name)} · ${esc(fmtTime(h.changed_at))}</li>`).join('')}</ul>
    <div class="row">${me ? '<button class="btn danger" id="del">Cancel booking</button>' : ''}<button class="btn alt" id="cx">Close</button></div>`);
  $('#cx').onclick = closeModal;
  if (me) {
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
  if (me) $('#del').onclick = async () => {
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
    <td>${esc(b.requester_name)}${b.branch ? `<br><small>${esc(b.branch)}</small>` : ''}</td>
    <td class="req">${esc(b.requirement)}</td>
    <td><select data-id="${b.id}" data-f="status">${STATUSES.map((s) => `<option ${s === b.status ? 'selected' : ''}>${s}</option>`).join('')}</select></td>
    <td><select data-id="${b.id}" data-f="assigned_to"><option value="">— unassigned —</option>${staffList.map((u) => `<option value="${u.id}" ${u.id === b.assigned_to ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}</select></td>
    <td><button class="btn sm alt" data-open="${b.id}">Details</button></td></tr>`).join('');
  app.innerHTML = `
    <div class="bar"><h2 style="text-align:left">Work board</h2><span class="spacer"></span>
      <select id="fs"><option value="">All statuses</option>${STATUSES.map((s) => `<option ${f.status === s ? 'selected' : ''}>${s}</option>`).join('')}</select>
      <select id="fa"><option value="">Anyone</option><option value="me" ${f.assigned === 'me' ? 'selected' : ''}>Assigned to me</option><option value="none" ${f.assigned === 'none' ? 'selected' : ''}>Unassigned</option></select>
    </div>
    ${bookings.length ? `<div class="tablewrap"><table><thead><tr><th>Slot</th><th>Requested by</th><th>Requirement</th><th>Status</th><th>Assigned</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`
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
      <b>Create backend user</b>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px">
        <div><label>Name</label><input name="name" required></div>
        <div><label>Username</label><input name="username" required></div>
        <div><label>Password</label><input name="password" type="text" minlength="6" required></div>
        <div><label>Role</label><select name="role"><option value="staff">staff (backend)</option><option value="admin">admin</option></select></div>
      </div>
      <div class="err" id="ue"></div><button class="btn">Create user</button>
    </form>
    <div class="tablewrap"><table><thead><tr><th>Name</th><th>Username</th><th>Role</th><th>Status</th><th></th></tr></thead><tbody>
    ${users.map((u) => `<tr><td>${esc(u.name)}</td><td>${esc(u.username)}</td><td>${esc(u.role)}</td><td>${u.active ? 'active' : 'disabled'}</td>
      <td><button class="btn sm alt" data-act="edit" data-id="${u.id}">Edit</button>${u.id === me.id ? '' : `
      <button class="btn sm alt" data-act="toggle" data-id="${u.id}" data-on="${u.active ? 1 : 0}">${u.active ? 'Disable' : 'Enable'}</button>
      <button class="btn sm danger" data-act="del" data-id="${u.id}">Delete</button>`}</td></tr>`).join('')}
    </tbody></table></div>`;
  $('#uf').onsubmit = async (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(e.target));
    const { error } = await sb.rpc('create_staff_user', { p_username: fd.username, p_name: fd.name, p_password: fd.password, p_role: fd.role });
    if (error) return ($('#ue').textContent = error.message);
    toast('User created'); await loadMe(); render();
  };
  app.querySelectorAll('[data-act]').forEach((b) => (b.onclick = async () => {
    try {
      if (b.dataset.act === 'toggle') must(await sb.rpc('set_staff_active', { p_id: b.dataset.id, p_active: b.dataset.on !== '1' }));
      else if (b.dataset.act === 'edit') return editUserDialog(users.find((u) => u.id === b.dataset.id));
      else {
        const u = users.find((x) => x.id === b.dataset.id);
        if (!confirm(`Delete ${u.name} (${u.username})? Their assigned bookings become unassigned. This cannot be undone.`)) return;
        must(await sb.rpc('delete_staff_user', { p_id: u.id }));
      }
      toast('Saved'); await loadMe(); render();
    } catch (e) { toast(e.message); }
  }));
}

function editUserDialog(u) {
  openModal(`<h3>Edit user</h3><form id="ef">
    <label>Name</label><input name="name" value="${esc(u.name)}" required>
    <label>Username</label><input name="username" value="${esc(u.username)}" required>
    <label>Role</label><select name="role"><option value="staff" ${u.role === 'staff' ? 'selected' : ''}>staff (backend)</option><option value="admin" ${u.role === 'admin' ? 'selected' : ''}>admin</option></select>
    <label>New password (leave blank to keep)</label><input name="password" type="text" minlength="6" autocomplete="off">
    <div class="err" id="ee"></div>
    <div class="row"><button type="button" class="btn alt" id="cx">Cancel</button><button class="btn">Save</button></div></form>`);
  $('#cx').onclick = closeModal;
  $('#ef').onsubmit = async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    const { error } = await sb.rpc('update_staff_user', { p_id: u.id, p_username: f.username, p_name: f.name, p_role: f.role, p_password: f.password || null });
    if (error) return ($('#ee').textContent = error.message);
    closeModal(); toast('User updated'); await loadMe(); render();
  };
}

boot();
