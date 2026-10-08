const $ = (s) => document.querySelector(s);
const app = $('#app'), nav = $('#nav'), who = $('#who');
const STATUSES = ['received', 'working', 'approval', 'rejected', 'completed'];
let token = localStorage.getItem('jl_token');
let me = null, meta = {}, view = 'calendar', month = null, pollTimer = null, staffList = [];

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const isStaff = () => me && (me.role === 'admin' || me.role === 'staff');
const chip = (s) => `<span class="chip s-${esc(s)}">${esc(s)}</span>`;
const fmtDate = (d) => new Date(d + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' });

async function api(path, method = 'GET', body) {
  const res = await fetch('/api' + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && token) { signOut(true); throw new Error('Please sign in'); }
  if (!res.ok) throw new Error(data.error || 'Something went wrong');
  return data;
}
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), 2800);
}
function openModal(html) { $('#sheet').innerHTML = html; $('#modal').hidden = false; }
function closeModal() { $('#modal').hidden = true; }
$('#modal').addEventListener('mousedown', (e) => { if (e.target.id === 'modal') closeModal(); });

// ---------- auth ----------
function signOut(silent) {
  if (!silent && token) api('/logout', 'POST').catch(() => {});
  token = null; me = null; localStorage.removeItem('jl_token'); clearInterval(pollTimer);
  renderAuth();
}
function renderAuth(mode = 'login') {
  nav.hidden = who.hidden = true;
  const signup = mode === 'signup';
  app.innerHTML = `<form class="card auth" id="authForm">
    <h2>${signup ? 'Create account' : 'Sign in'}</h2>
    ${signup ? '<label>Your name</label><input name="name" required>' : ''}
    <label>Username</label><input name="username" autocomplete="username" required>
    <label>Password</label><input name="password" type="password" autocomplete="${signup ? 'new-password' : 'current-password'}" required>
    <div class="err" id="authErr"></div>
    <button class="btn" style="width:100%;margin-top:8px">${signup ? 'Sign up' : 'Sign in'}</button>
    <p style="text-align:center">${signup ? 'Have an account?' : 'New here?'}
      <button type="button" class="link" id="swap">${signup ? 'Sign in' : 'Create an account'}</button></p>
  </form>`;
  $('#swap').onclick = () => renderAuth(signup ? 'login' : 'signup');
  $('#authForm').onsubmit = async (e) => {
    e.preventDefault();
    try {
      const r = await api(signup ? '/signup' : '/login', 'POST', Object.fromEntries(new FormData(e.target)));
      token = r.token; localStorage.setItem('jl_token', token);
      await boot();
    } catch (err) { $('#authErr').textContent = err.message; }
  };
}

async function boot() {
  try {
    const r = await api('/me');
    me = r.user; meta = r;
  } catch { return renderAuth(); }
  if (isStaff()) staffList = (await api('/users')).users.filter((u) => u.role !== 'requester' && u.active);
  const today = new Date();
  month = month || meta.minDate.slice(0, 7);
  view = isStaff() ? 'board' : 'calendar';
  who.hidden = nav.hidden = false;
  who.innerHTML = `${esc(me.name)} <span class="chip">${esc(me.role)}</span><button class="btn sm alt" id="out">Sign out</button>`;
  $('#out').onclick = () => signOut();
  renderNav();
  render();
  clearInterval(pollTimer);
  pollTimer = setInterval(() => { if ($('#modal').hidden && !document.hidden && !isTyping()) render(true); }, 10000);
}
const isTyping = () => ['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName);

function renderNav() {
  const tabs = [['calendar', 'Calendar'], [isStaff() ? 'board' : 'mine', isStaff() ? 'Work board' : 'My bookings']];
  if (me.role === 'admin') tabs.push(['users', 'Users']);
  nav.innerHTML = tabs.map(([k, l]) => `<button data-v="${k}" class="${view === k ? 'on' : ''}">${l}</button>`).join('');
  nav.querySelectorAll('button').forEach((b) => (b.onclick = () => { view = b.dataset.v; renderNav(); render(); }));
}
function render(quiet) {
  const fn = { calendar: renderCalendar, board: renderBoard, mine: renderBoard, users: renderUsers }[view];
  fn(quiet).catch((e) => { if (!quiet) toast(e.message); });
}

// ---------- calendar ----------
async function renderCalendar() {
  const data = await api('/calendar?month=' + month);
  const [y, m] = month.split('-').map(Number);
  const first = new Date(y, m - 1, 1), days = new Date(y, m, 0).getDate();
  const by = {};
  data.bookings.forEach((b) => (by[b.slot_date + '|' + b.slot_no] = b));
  let cells = '';
  for (let i = 0; i < first.getDay(); i++) cells += '<div class="day pad"></div>';
  for (let d = 1; d <= days; d++) {
    const date = `${month}-${String(d).padStart(2, '0')}`;
    const past = date < data.min, out = date > data.max;
    const slots = [1, 2].map((n) => {
      const b = by[date + '|' + n];
      if (b) return `<button class="slot s-${b.status} ${b.mine ? 'mine' : ''}" data-id="${b.id}" ${b.mine || isStaff() ? '' : 'disabled'} title="${esc(b.requested_by_name)} · ${b.status}">S${n} · ${esc(b.requested_by_name)}</button>`;
      return `<button class="slot s-free" data-date="${date}" data-n="${n}" ${past || out ? 'disabled' : ''}>S${n} · Free</button>`;
    }).join('');
    cells += `<div class="day ${past ? 'past' : ''} ${date === data.min ? 'today' : ''}"><span class="n">${d}</span>${out ? '' : slots}</div>`;
  }
  app.innerHTML = `
    <div class="bar">
      <button class="btn alt" id="prev">&larr;</button>
      <h2>${first.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</h2>
      <button class="btn alt" id="next">&rarr;</button>
      <input type="month" id="jump" value="${month}" min="${data.min.slice(0, 7)}" max="${data.max.slice(0, 7)}">
      <span class="spacer"></span>
      <span style="font-weight:600">2 slots per day · open until ${fmtDate(data.max)}</span>
    </div>
    <div class="legend">${['free', ...STATUSES].map(chip).join('')}</div>
    <div class="cal">${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => `<div class="dow">${d}</div>`).join('')}${cells}</div>`;
  const shift = (n) => { const d = new Date(y, m - 1 + n, 1); const v = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; if (v >= data.min.slice(0, 7) && v <= data.max.slice(0, 7)) { month = v; render(); } };
  $('#prev').onclick = () => shift(-1);
  $('#next').onclick = () => shift(1);
  $('#jump').onchange = (e) => { if (e.target.value) { month = e.target.value; render(); } };
  app.querySelectorAll('.slot[data-date]').forEach((b) => (b.onclick = () => bookDialog(b.dataset.date, +b.dataset.n)));
  app.querySelectorAll('.slot[data-id]').forEach((b) => (b.onclick = () => detailDialog(b.dataset.id)));
}

function bookDialog(date, n) {
  openModal(`<h3>Book ${fmtDate(date)} · Slot ${n}</h3>
    <form id="bf"><label>What do you need posted?</label>
    <textarea name="requirement" maxlength="4000" placeholder="Describe the post requirement…" required></textarea>
    <div class="err" id="be"></div>
    <div class="row"><button type="button" class="btn alt" id="cx">Cancel</button><button class="btn">Book slot</button></div></form>`);
  $('#cx').onclick = closeModal;
  $('#bf').onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api('/bookings', 'POST', { slot_date: date, slot_no: n, requirement: new FormData(e.target).get('requirement') });
      closeModal(); toast('Slot booked'); render();
    } catch (err) { $('#be').textContent = err.message; if (/taken/.test(err.message)) render(); }
  };
}

async function detailDialog(id) {
  const { booking: b, history } = await api('/bookings/' + id);
  const canCancel = isStaff() || b.status === 'received';
  openModal(`<h3>${fmtDate(b.slot_date)} · Slot ${b.slot_no}</h3>
    <p>${chip(b.status)} &nbsp; by <b>${esc(b.requested_by_name)}</b> · assigned: <b>${esc(b.assigned_to_name || 'nobody yet')}</b></p>
    <div class="req-text">${esc(b.requirement)}</div>
    <b>History</b><ul class="hist">${history.map((h) => `<li>${chip(h.status)} ${esc(h.changed_by_name)} · ${esc(h.changed_at)} UTC${h.note ? '<br>' + esc(h.note) : ''}</li>`).join('')}</ul>
    <div class="row">${canCancel ? '<button class="btn danger" id="del">Cancel booking</button>' : ''}<button class="btn alt" id="cx">Close</button></div>`);
  $('#cx').onclick = closeModal;
  if (canCancel) $('#del').onclick = async () => {
    if (!confirm('Cancel this booking and free the slot?')) return;
    try { await api('/bookings/' + id, 'DELETE'); closeModal(); toast('Booking cancelled'); render(); } catch (e) { toast(e.message); }
  };
}

// ---------- board / my bookings ----------
async function renderBoard(quiet) {
  const staff = isStaff();
  const f = renderBoard.f || (renderBoard.f = { status: '', assigned: '' });
  const q = new URLSearchParams(staff ? f : {}).toString();
  const { bookings } = await api('/bookings' + (q ? '?' + q : ''));
  const keepScroll = window.scrollY;
  const rows = bookings.map((b) => `<tr>
    <td><b>${fmtDate(b.slot_date)}</b><br>Slot ${b.slot_no}</td>
    <td>${esc(b.requested_by_name)}</td>
    <td class="req">${esc(b.requirement)}</td>
    <td>${staff ? `<select data-id="${b.id}" data-f="status">${STATUSES.map((s) => `<option ${s === b.status ? 'selected' : ''}>${s}</option>`).join('')}</select>` : chip(b.status)}</td>
    <td>${staff ? `<select data-id="${b.id}" data-f="assigned_to"><option value="">— unassigned —</option>${staffList.map((u) => `<option value="${u.id}" ${u.id === b.assigned_to ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}</select>` : esc(b.assigned_to_name || '—')}</td>
    <td><button class="btn sm alt" data-open="${b.id}">Details</button></td></tr>`).join('');
  app.innerHTML = `
    <div class="bar"><h2 style="text-align:left">${staff ? 'Work board' : 'My bookings'}</h2><span class="spacer"></span>
    ${staff ? `<select id="fs"><option value="">All statuses</option>${STATUSES.map((s) => `<option ${f.status === s ? 'selected' : ''}>${s}</option>`).join('')}</select>
      <select id="fa"><option value="">Anyone</option><option value="me" ${f.assigned === 'me' ? 'selected' : ''}>Assigned to me</option><option value="none" ${f.assigned === 'none' ? 'selected' : ''}>Unassigned</option></select>` : ''}
    </div>
    ${bookings.length ? `<div class="tablewrap"><table><thead><tr><th>Slot</th><th>Requested by</th><th>Requirement</th><th>Status</th><th>Assigned</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`
      : '<div class="card empty">No bookings yet. Pick a free slot on the calendar.</div>'}`;
  window.scrollTo(0, keepScroll);
  if (staff) {
    $('#fs').onchange = (e) => { f.status = e.target.value; render(); };
    $('#fa').onchange = (e) => { f.assigned = e.target.value; render(); };
    app.querySelectorAll('select[data-id]').forEach((s) => (s.onchange = async () => {
      const v = s.value;
      try { await api('/bookings/' + s.dataset.id, 'PATCH', { [s.dataset.f]: s.dataset.f === 'assigned_to' ? (v ? +v : null) : v }); toast('Updated'); }
      catch (e) { toast(e.message); render(); }
    }));
  }
  app.querySelectorAll('[data-open]').forEach((b) => (b.onclick = () => detailDialog(b.dataset.open)));
}

// ---------- users (admin) ----------
async function renderUsers() {
  const { users } = await api('/users');
  app.innerHTML = `
    <div class="bar"><h2 style="text-align:left">Users</h2></div>
    <form class="card" id="uf" style="margin-bottom:18px">
      <b>Create user</b>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px">
        <div><label>Name</label><input name="name" required></div>
        <div><label>Username</label><input name="username" required></div>
        <div><label>Password</label><input name="password" type="text" minlength="6" required></div>
        <div><label>Role</label><select name="role"><option value="staff">staff (backend)</option><option value="admin">admin</option><option value="requester">requester</option></select></div>
      </div>
      <div class="err" id="ue"></div><button class="btn">Create user</button>
    </form>
    <div class="tablewrap"><table><thead><tr><th>Name</th><th>Username</th><th>Role</th><th>Status</th><th></th></tr></thead><tbody>
    ${users.map((u) => `<tr><td>${esc(u.name)}</td><td>${esc(u.username)}</td><td>${esc(u.role)}</td><td>${u.active ? 'active' : 'disabled'}</td>
      <td>${u.id === me.id ? '' : `<button class="btn sm alt" data-act="toggle" data-id="${u.id}" data-on="${u.active ? 1 : 0}">${u.active ? 'Disable' : 'Enable'}</button>
      <button class="btn sm alt" data-act="pw" data-id="${u.id}">Reset password</button>`}</td></tr>`).join('')}
    </tbody></table></div>`;
  $('#uf').onsubmit = async (e) => {
    e.preventDefault();
    try { await api('/users', 'POST', Object.fromEntries(new FormData(e.target))); toast('User created'); render(); }
    catch (err) { $('#ue').textContent = err.message; }
  };
  app.querySelectorAll('[data-act]').forEach((b) => (b.onclick = async () => {
    try {
      if (b.dataset.act === 'toggle') await api('/users/' + b.dataset.id, 'PATCH', { active: b.dataset.on !== '1' });
      else { const pw = prompt('New password (min 6 chars):'); if (!pw) return; await api('/users/' + b.dataset.id, 'PATCH', { password: pw }); }
      toast('Saved'); render();
    } catch (e) { toast(e.message); }
  }));
}

token ? boot() : renderAuth();
