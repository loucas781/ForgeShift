// ── ForgeShift App ─────────────────────────────────────────────────────────

class RotaApp {
  constructor() {
    this.cal       = new CalendarEngine();
    this.shifts    = [];
    this.locations = [];
    this.templates = [];
    this.users     = [];
    this.page      = 'calendar';
    this.editShiftData    = null;
    this.editTemplateData = null;
  }

  // ── Bootstrap ─────────────────────────────────────────────────────────────

  async boot() {
    await appState.init();
    if (!appState.currentUser) {
      await this.mountAuth();
    } else {
      await this.loadBaseData();
      await this.mountApp();
    }
  }

  async loadBaseData() {
    try {
      const [locsRes] = await Promise.all([api.getLocations()]);
      this.locations = locsRes.locations || [];
    } catch (e) { console.warn('loadBaseData error', e); }
  }

  // ── Auth ──────────────────────────────────────────────────────────────────

  async mountAuth(mode = 'login') {
    const signupEnabled = await api.signupEnabled().then(r => r.enabled).catch(() => false);
    document.getElementById('root').innerHTML = mode === 'signup'
      ? this.tplSignup()
      : this.tplLogin(signupEnabled);
  }

  tplLogin(signupEnabled = true) {
    return `
      <div class="auth-screen">
        <div class="auth-card">
          <div class="auth-logo">
            <div class="logo-icon">📅</div>
            <h1>ForgeShift</h1>
            <p>Shift Rota Management</p>
          </div>
          <h2>Welcome back</h2>
          <p class="subtitle">Sign in to your account</p>
          <div id="auth-error" class="alert alert-error hidden"><span class="alert-icon">⚠</span><span id="auth-error-msg"></span></div>
          <div class="form-group"><label>Email or Username</label>
            <input type="text" id="login-id" placeholder="admin" autocomplete="username"
              onkeydown="if(event.key==='Enter')app.doLogin()">
          </div>
          <div class="form-group"><label>Password</label>
            <input type="password" id="login-pw" placeholder="••••••••" autocomplete="current-password"
              onkeydown="if(event.key==='Enter')app.doLogin()">
          </div>
          <button class="btn btn-primary btn-full btn-lg" onclick="app.doLogin()">Sign In</button>
          ${signupEnabled ? `
          <div class="mt-4" style="text-align:center">
            <span class="text-muted text-sm">No account? </span>
            <button class="btn btn-ghost btn-sm" onclick="app.mountAuth('signup')">Sign Up</button>
          </div>` : ''}
        </div>
      </div>`;
  }

  tplSignup() {
    return `
      <div class="auth-screen">
        <div class="auth-card">
          <div class="auth-logo">
            <div class="logo-icon">📅</div>
            <h1>ForgeShift</h1>
            <p>Create your account</p>
          </div>
          <h2>Create account</h2>
          <p class="subtitle">Join your team's rota</p>
          <div id="auth-error" class="alert alert-error hidden"><span class="alert-icon">⚠</span><span id="auth-error-msg"></span></div>
          <div class="form-group"><label>Full Name</label><input type="text" id="reg-name" placeholder="Jane Smith"></div>
          <div class="form-group"><label>Username</label><input type="text" id="reg-username" placeholder="janesmith"></div>
          <div class="form-group"><label>Email</label><input type="email" id="reg-email" placeholder="jane@company.com"></div>
          <div class="form-group"><label>Password</label><input type="password" id="reg-pw" placeholder="At least 8 characters"></div>
          <button class="btn btn-primary btn-full btn-lg" onclick="app.doRegister()">Create Account</button>
          <div class="mt-4" style="text-align:center">
            <button class="btn btn-ghost btn-sm" onclick="app.mountAuth('login')">← Back to sign in</button>
          </div>
        </div>
      </div>`;
  }

  async doLogin() {
    const identifier = document.getElementById('login-id').value.trim();
    const password   = document.getElementById('login-pw').value;
    try {
      this.showAuthError('');
      const { user } = await api.login(identifier, password);
      appState.currentUser = user;
      await this.loadBaseData();
      await this.mountApp();
    } catch (e) {
      this.showAuthError(e.message);
    }
  }

  async doRegister() {
    const name     = document.getElementById('reg-name').value.trim();
    const username = document.getElementById('reg-username').value.trim();
    const email    = document.getElementById('reg-email').value.trim();
    const password = document.getElementById('reg-pw').value;
    try {
      this.showAuthError('');
      await api.register({ name, username, email, password });
      toast('Account created! Please sign in.', 'success');
      await this.mountAuth('login');
    } catch (e) {
      this.showAuthError(e.message);
    }
  }

  showAuthError(msg) {
    const err = document.getElementById('auth-error');
    const msgEl = document.getElementById('auth-error-msg');
    if (!err) return;
    if (msg) { err.classList.remove('hidden'); msgEl.textContent = msg; }
    else      { err.classList.add('hidden'); }
  }

  // ── App Shell ─────────────────────────────────────────────────────────────

  async mountApp() {
    document.getElementById('root').innerHTML = this.tplShell();
    await this.navigate('calendar');
  }

  tplShell() {
    const u = appState.currentUser;
    return `
      <div id="sidebar-backdrop" class="sidebar-backdrop" onclick="app.closeSidebar()"></div>
      <aside class="sidebar" id="sidebar">
        <div class="sidebar-header">
          <div class="sidebar-logo">📅</div>
          <div>
            <div class="sidebar-title">ForgeShift</div>
            <div class="sidebar-subtitle" id="sidebar-env-label">${appState.envLabel} · ${appState.versionShort}</div>
          </div>
        </div>
        <nav class="nav-section">
          <div class="nav-section-label">Workspace</div>
          <button class="nav-item" data-page="calendar" onclick="app.navigate('calendar')"><span class="nav-icon">📅</span>Calendar</button>
          <button class="nav-item" data-page="templates" onclick="app.navigate('templates')"><span class="nav-icon">📋</span>Templates</button>
          <button class="nav-item" data-page="locations" onclick="app.navigate('locations')"><span class="nav-icon">📍</span>Locations</button>
        </nav>
        ${appState.isAdmin() ? `
        <nav class="nav-section">
          <div class="nav-section-label">Admin</div>
          <button class="nav-item" data-page="users" onclick="app.navigate('users')"><span class="nav-icon">👥</span>Users</button>
          <button class="nav-item" data-page="settings" onclick="app.navigate('settings')"><span class="nav-icon">⚙️</span>Settings</button>
        </nav>` : ''}
        <div class="sidebar-footer">
          <button class="nav-item" data-page="profile" onclick="app.navigate('profile')"><span class="nav-icon">🧑</span>My Profile</button>
          <div class="user-card" onclick="app.navigate('profile')">
            <div class="user-avatar">${(u?.name||'U').charAt(0).toUpperCase()}</div>
            <div class="user-info">
              <div class="user-name">${u?.name}</div>
              <div class="user-role">${u?.role}</div>
            </div>
          </div>
        </div>
      </aside>
      <main class="main-content">
        <header class="topbar">
          <button class="menu-toggle" onclick="app.toggleSidebar()">☰</button>
          <span class="topbar-title" id="topbar-title">Calendar</span>
          <div class="topbar-controls" id="topbar-controls"></div>
        </header>
        <div id="page-area"></div>
      </main>
      ${this.tplModals()}`;
  }

  tplModals() {
    return `
      <!-- Shift Modal -->
      <div class="modal-overlay hidden" id="shift-modal">
        <div class="modal">
          <div class="modal-header">
            <h3 id="shift-modal-title">Add Shift</h3>
            <button class="modal-close" onclick="hideModal('shift-modal')">✕</button>
          </div>
          <div class="modal-body" id="shift-modal-body"></div>
          <div class="modal-footer">
            <button class="btn btn-danger btn-sm hidden" id="shift-del-btn" onclick="app.deleteShift()">Delete Shift</button>
            <button class="btn btn-secondary" onclick="hideModal('shift-modal')">Cancel</button>
            <button class="btn btn-primary" onclick="app.saveShift()">Save</button>
          </div>
        </div>
      </div>

      <!-- Template Modal -->
      <div class="modal-overlay hidden" id="tpl-modal">
        <div class="modal modal-xl">
          <div class="modal-header">
            <h3 id="tpl-modal-title">Create Template</h3>
            <button class="modal-close" onclick="hideModal('tpl-modal')">✕</button>
          </div>
          <div class="modal-body" id="tpl-modal-body"></div>
          <div class="modal-footer">
            <button class="btn btn-secondary" onclick="hideModal('tpl-modal')">Cancel</button>
            <button class="btn btn-primary" onclick="app.saveTemplate()">Save Template</button>
          </div>
        </div>
      </div>

      <!-- Apply Template Modal -->
      <div class="modal-overlay hidden" id="apply-modal">
        <div class="modal">
          <div class="modal-header">
            <h3>Apply Template to Week</h3>
            <button class="modal-close" onclick="hideModal('apply-modal')">✕</button>
          </div>
          <div class="modal-body" id="apply-modal-body"></div>
          <div class="modal-footer">
            <button class="btn btn-secondary" onclick="hideModal('apply-modal')">Cancel</button>
            <button class="btn btn-primary" onclick="app.doApplyTemplate()">Apply</button>
          </div>
        </div>
      </div>

      <!-- User Modal -->
      <div class="modal-overlay hidden" id="user-modal">
        <div class="modal">
          <div class="modal-header">
            <h3 id="user-modal-title">Create User</h3>
            <button class="modal-close" onclick="hideModal('user-modal')">✕</button>
          </div>
          <div class="modal-body" id="user-modal-body"></div>
          <div class="modal-footer">
            <button class="btn btn-secondary" onclick="hideModal('user-modal')">Cancel</button>
            <button class="btn btn-primary" onclick="app.saveUser()">Save User</button>
          </div>
        </div>
      </div>

      <!-- Location Modal -->
      <div class="modal-overlay hidden" id="loc-modal">
        <div class="modal">
          <div class="modal-header">
            <h3 id="loc-modal-title">Add Location</h3>
            <button class="modal-close" onclick="hideModal('loc-modal')">✕</button>
          </div>
          <div class="modal-body" id="loc-modal-body"></div>
          <div class="modal-footer">
            <button class="btn btn-secondary" onclick="hideModal('loc-modal')">Cancel</button>
            <button class="btn btn-primary" onclick="app.saveLocation()">Save</button>
          </div>
        </div>
      </div>

      <!-- Confirm Modal -->
      <div class="modal-overlay hidden" id="confirm-modal">
        <div class="modal">
          <div class="modal-header">
            <h3 id="confirm-title">Confirm</h3>
            <button class="modal-close" onclick="hideModal('confirm-modal')">✕</button>
          </div>
          <div class="modal-body"><p id="confirm-msg" style="font-size:14px;color:var(--text-secondary)"></p></div>
          <div class="modal-footer">
            <button class="btn btn-secondary" onclick="hideModal('confirm-modal')">Cancel</button>
            <button class="btn btn-danger" id="confirm-ok">Confirm</button>
          </div>
        </div>
      </div>`;
  }

  // ── Navigation ────────────────────────────────────────────────────────────

  async navigate(page) {
    this.page = page;
    this.closeSidebar();

    const TITLES = { calendar:'Calendar', templates:'Templates', locations:'Locations', users:'User Management', settings:'Settings', profile:'My Profile' };
    document.getElementById('topbar-title').textContent = TITLES[page] || page;

    document.querySelectorAll('.nav-item[data-page]').forEach(el => {
      el.classList.toggle('active', el.dataset.page === page);
    });

    const area     = document.getElementById('page-area');
    const controls = document.getElementById('topbar-controls');

    switch (page) {
      case 'calendar':
        controls.innerHTML = this.tplCalControls();
        await this.refreshShifts();
        area.innerHTML = `<div class="calendar-container">
          <div class="calendar-toolbar">
            <div class="calendar-nav">
              <button class="nav-btn" onclick="app.calNav(-1)">‹</button>
              <span class="month-display" id="cal-title">${this.cal.title()}</span>
              <button class="nav-btn" onclick="app.calNav(1)">›</button>
            </div>
          </div>
          <div class="calendar-grid-wrapper" id="cal-grid">${this.renderGrid()}</div>
        </div>`;
        break;

      case 'templates':
        controls.innerHTML = `<button class="btn btn-primary btn-sm" onclick="app.openTplModal()">+ New Template</button>`;
        await this.refreshTemplates();
        area.innerHTML = await this.tplTemplatesPage();
        break;

      case 'locations':
        controls.innerHTML = `<button class="btn btn-primary btn-sm" onclick="app.openLocModal()">+ Add Location</button>`;
        area.innerHTML = this.tplLocationsPage();
        break;

      case 'users':
        if (!appState.isAdmin()) return this.navigate('calendar');
        controls.innerHTML = `<button class="btn btn-primary btn-sm" onclick="app.openUserModal()">+ Add User</button>`;
        await this.refreshUsers();
        area.innerHTML = this.tplUsersPage();
        break;

      case 'settings':
        if (!appState.isAdmin()) return this.navigate('calendar');
        controls.innerHTML = '';
        area.innerHTML = await this.tplSettingsPage();
        break;

      case 'profile':
        controls.innerHTML = '';
        area.innerHTML = this.tplProfilePage();
        // Load iCal section async after render
        setTimeout(() => this.loadIcalSection(), 0);
        break;
    }
  }

  // ── Calendar ──────────────────────────────────────────────────────────────

  tplCalControls() {
    return `
      <div class="view-switcher">
        <button class="view-btn ${this.cal.view==='month'?'active':''}" onclick="app.setView('month')">Month</button>
        <button class="view-btn ${this.cal.view==='week'?'active':''}" onclick="app.setView('week')">Week</button>
        <button class="view-btn ${this.cal.view==='day'?'active':''}" onclick="app.setView('day')">Day</button>
      </div>
      <button class="btn btn-secondary btn-sm" onclick="app.goToday()">Today</button>
      ${appState.isAdmin() ? `<button class="btn btn-primary btn-sm" onclick="app.openApplyModal()">Apply Template</button>` : ''}`;
  }

  async refreshShifts(params = {}) {
    try {
      const { shifts } = await api.getShifts(params);
      this.shifts = shifts || [];
    } catch (e) { this.shifts = []; }
  }

  shiftsFor(dateStr) {
    return this.shifts.filter(s => s.date === dateStr);
  }

  loc(id) {
    return this.locations.find(l => l.id === id);
  }

  renderGrid() {
    const v = this.cal.view;
    if (v === 'month') return this.renderMonth();
    if (v === 'week')  return this.renderWeek();
    return this.renderDay();
  }

  renderMonth() {
    const d = this.cal.date;
    const days = this.cal.getMonthGrid(d.getFullYear(), d.getMonth());
    const wds  = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];

    let h = `<div class="calendar-weekdays">${wds.map(w => `<div class="weekday-header">${w}</div>`).join('')}</div><div class="calendar-grid">`;

    days.forEach(({ day, month, year, other }) => {
      const ds     = this.cal.isoDate(year, month, day);
      const shifts = this.shiftsFor(ds);
      const today  = this.cal.isToday(year, month, day);

      h += `<div class="cal-day ${other?'other-month':''} ${today?'today':''}" onclick="app.clickDay('${ds}')">`;
      h += `<div class="day-header"><div class="day-number">${day}</div>`;
      if (shifts.length) {
        h += `<div class="day-badges">${shifts.slice(0,3).map(s =>
          `<div class="day-badge" style="background:${s.location_color||'#6366f1'}"></div>`).join('')}</div>`;
      }
      h += `</div>`;

      // Tint overlay from first note color
      const tinted = shifts.find(s => s.note_color);
      if (tinted) h += `<div class="day-tint" style="background:${tinted.note_color}"></div>`;

      shifts.slice(0, 3).forEach(s => {
        const bg = s.location_color || '#6366f1';
        h += `<div class="shift-chip" style="background:${bg}22;color:${bg};border:1px solid ${bg}44"
          onclick="event.stopPropagation();app.openShiftModal('${s.id}')">
          <div class="chip-dot" style="background:${bg}"></div>
          <span>${s.location_name || '?'}</span>
          ${appState.isAdmin() && s.user_name ? `<span style="opacity:.5;font-size:9px;margin-left:auto">${s.user_name.split(' ')[0]}</span>` : ''}
          ${s.notes ? `<span style="opacity:.5;margin-left:2px">📝</span>` : ''}
        </div>`;
      });
      if (shifts.length > 3) h += `<div style="font-size:10px;color:var(--text-muted);padding:2px">+${shifts.length-3} more</div>`;

      h += `</div>`;
    });
    return h + '</div>';
  }

  renderWeek() {
    const wdays = this.cal.getWeekDays(this.cal.date);
    const names = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
    const today = new Date();

    let h = `<div style="overflow-x:auto"><div style="display:grid;grid-template-columns:repeat(7,1fr);min-width:560px">`;

    wdays.forEach((d, i) => {
      const isToday = d.toDateString() === today.toDateString();
      h += `<div style="border-right:1px solid var(--border);border-bottom:1px solid var(--border);padding:10px 8px;text-align:center;background:${isToday?'var(--accent-light)':''}">
        <div style="font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:var(--text-muted)">${names[i]}</div>
        <div style="font-size:20px;font-weight:700;color:${isToday?'var(--accent)':'inherit'}">${d.getDate()}</div>
      </div>`;
    });

    wdays.forEach(d => {
      const ds = this.cal.formatDate(d);
      const shifts = this.shiftsFor(ds);
      h += `<div style="border-right:1px solid var(--border);border-bottom:1px solid var(--border);padding:6px;min-height:100px;cursor:pointer"
        onclick="app.clickDay('${ds}')">`;
      shifts.forEach(s => {
        const bg = s.location_color || '#6366f1';
        h += `<div class="shift-chip" style="background:${bg}22;color:${bg};border:1px solid ${bg}44;margin-bottom:3px"
          onclick="event.stopPropagation();app.openShiftModal('${s.id}')">
          <div class="chip-dot" style="background:${bg}"></div>
          <span>${s.location_name||'?'}</span>
        </div>`;
      });
      h += '</div>';
    });

    return h + '</div></div>';
  }

  renderDay() {
    const d  = this.cal.date;
    const ds = this.cal.formatDate(d);
    const shifts = this.shiftsFor(ds);

    let h = `<div class="day-view-container">
      <div class="day-view-header">
        <h2>${d.toLocaleDateString('en-GB', { weekday:'long', day:'numeric', month:'long', year:'numeric' })}</h2>
        <button class="btn btn-primary btn-sm mt-2" onclick="app.clickDay('${ds}')">+ Add Shift</button>
      </div>`;

    if (!shifts.length) {
      h += `<div style="text-align:center;padding:60px 20px;color:var(--text-muted)">
        <div style="font-size:42px;margin-bottom:12px">📭</div>
        <div style="font-size:15px;font-weight:600">No shifts today</div>
        <div style="font-size:13px;margin-top:4px">Click "+ Add Shift" to schedule one</div>
      </div>`;
    } else {
      shifts.forEach(s => {
        const bg = s.location_color || '#6366f1';
        h += `<div class="card" style="margin-bottom:12px;border-left:4px solid ${bg}">
          <div class="card-body" style="padding:16px">
            <div class="flex items-center justify-between gap-3">
              <div class="flex items-center gap-2">
                <div class="loc-dot" style="background:${bg};width:12px;height:12px"></div>
                <span style="font-weight:700;font-size:15px">${s.location_name||'Unknown'}</span>
                ${appState.isAdmin() && s.user_name ? `<span class="badge badge-muted">${s.user_name}</span>` : ''}
              </div>
              <div class="flex gap-2">
                <button class="btn btn-ghost btn-sm" onclick="app.openShiftModal('${s.id}')">Edit</button>
                <button class="btn btn-danger btn-sm" onclick="app.confirmDeleteShift('${s.id}')">Delete</button>
              </div>
            </div>
            <div style="color:var(--text-muted);font-size:13px;margin-top:6px">${fmtTime(s.start_time)} – ${fmtTime(s.end_time)}</div>
            ${s.notes ? `<div style="margin-top:10px;padding:10px;border-radius:var(--radius-sm);font-size:13px;border-left:3px solid ${s.note_color||'var(--border)'};background:${s.note_color?s.note_color+'18':'var(--bg-surface2)'}">
              <strong>📝 Notes:</strong><br>${s.notes}
            </div>` : ''}
          </div>
        </div>`;
      });
    }
    return h + '</div>';
  }

  calNav(dir) {
    this.cal.navigate(dir);
    document.getElementById('cal-title').textContent = this.cal.title();
    document.getElementById('cal-grid').innerHTML = this.renderGrid();
  }

  goToday() {
    this.cal.goToToday();
    document.getElementById('cal-title').textContent = this.cal.title();
    document.getElementById('cal-grid').innerHTML = this.renderGrid();
  }

  async setView(v) { this.cal.view = v; await this.navigate('calendar'); }

  clickDay(ds) { this.openShiftModal(null, ds); }

  // ── Shift Modal ───────────────────────────────────────────────────────────

  async openShiftModal(shiftId = null, dateStr = null) {
    let shift = null;
    if (shiftId) {
      try { shift = (await api.request('GET', `/shifts/${shiftId}`)).shift; } catch {}
    }
    this.editShiftData = shift;

    document.getElementById('shift-modal-title').textContent = shift ? 'Edit Shift' : 'Add Shift';
    document.getElementById('shift-del-btn').classList.toggle('hidden', !shift);

    const users = appState.isAdmin() ? (await api.getUsers().catch(() => ({ users: [] }))).users : [];

    document.getElementById('shift-modal-body').innerHTML = `
      <div class="form-group"><label>Date</label>
        <input type="date" id="sm-date" value="${shift?.date || dateStr || new Date().toISOString().split('T')[0]}">
      </div>
      ${appState.isAdmin() ? `
      <div class="form-group"><label>User</label>
        <select id="sm-user">
          ${users.filter(u=>u.active).map(u=>`<option value="${u.id}" ${shift?.user_id===u.id?'selected':''}>${u.name}</option>`).join('')}
        </select>
      </div>` : `<input type="hidden" id="sm-user" value="${appState.currentUser.id}">`}
      <div class="form-group"><label>Location</label>
        <select id="sm-loc">
          ${this.locations.map(l=>`<option value="${l.id}" ${(shift?.location_id===l.id)?'selected':''}>${l.name}</option>`).join('')}
        </select>
      </div>
      <div class="flex gap-3">
        <div class="form-group flex-1"><label>Start</label><input type="time" id="sm-start" value="${shift?.start_time||'09:00'}"></div>
        <div class="form-group flex-1"><label>End</label><input type="time" id="sm-end" value="${shift?.end_time||'17:00'}"></div>
      </div>
      <div class="form-group"><label>Notes</label>
        <textarea id="sm-notes" placeholder="Tasks, instructions...">${shift?.notes||''}</textarea>
      </div>
      <div class="form-group"><label>Note Colour</label>
        <div class="color-palette">${colorPalette(shift?.note_color||'','app.pickShiftColor')}</div>
        <input type="hidden" id="sm-color" value="${shift?.note_color||''}">
      </div>`;

    showModal('shift-modal');
  }

  pickShiftColor(el, color) {
    el.closest('.color-palette').querySelectorAll('.color-swatch').forEach(s=>s.classList.remove('selected'));
    el.classList.add('selected');
    document.getElementById('sm-color').value = color;
  }

  async saveShift() {
    const date       = document.getElementById('sm-date').value;
    const userId     = document.getElementById('sm-user').value;
    const locationId = document.getElementById('sm-loc').value;
    const startTime  = document.getElementById('sm-start').value;
    const endTime    = document.getElementById('sm-end').value;
    const notes      = document.getElementById('sm-notes').value;
    const noteColor  = document.getElementById('sm-color').value || null;

    if (!date || !locationId) return toast('Please fill required fields', 'error');

    try {
      if (this.editShiftData) {
        await api.updateShift(this.editShiftData.id, { date, userId, locationId, startTime, endTime, notes, noteColor });
        toast('Shift updated', 'success');
      } else {
        await api.createShift({ date, userId, locationId, startTime, endTime, notes, noteColor });
        toast('Shift added', 'success');
      }
      hideModal('shift-modal');
      await this.refreshShifts();
      document.getElementById('cal-grid').innerHTML = this.renderGrid();
    } catch (e) { toast(e.message, 'error'); }
  }

  async deleteShift() {
    if (!this.editShiftData) return;
    try {
      await api.deleteShift(this.editShiftData.id);
      toast('Shift deleted', 'success');
      hideModal('shift-modal');
      await this.refreshShifts();
      document.getElementById('cal-grid').innerHTML = this.renderGrid();
    } catch (e) { toast(e.message, 'error'); }
  }

  confirmDeleteShift(id) {
    this.confirm('Delete Shift', 'Delete this shift permanently?', async () => {
      await api.deleteShift(id);
      toast('Deleted', 'success');
      await this.refreshShifts();
      document.getElementById('cal-grid').innerHTML = this.renderGrid();
    });
  }

  // ── Templates ─────────────────────────────────────────────────────────────

  async refreshTemplates() {
    try { this.templates = (await api.getTemplates()).templates || []; }
    catch { this.templates = []; }
  }

  async tplTemplatesPage() {
    const tpls = this.templates;
    if (!tpls.length) return `
      <div class="page-content" style="text-align:center;padding-top:80px">
        <div style="font-size:48px;margin-bottom:16px">📋</div>
        <div style="font-size:16px;font-weight:600">No templates yet</div>
        <div class="text-muted text-sm mt-2">Create reusable weekly shift patterns</div>
        <button class="btn btn-primary mt-4" onclick="app.openTplModal()">+ Create Template</button>
      </div>`;

    const days = ['M','T','W','T','F','S','S'];
    let h = `<div class="page-content"><div class="page-header"><div><h2>Templates</h2><p class="text-muted text-sm">Reusable weekly shift patterns</p></div></div><div class="template-grid">`;

    tpls.forEach(t => {
      h += `<div class="template-card">
        <div class="flex items-center justify-between mb-2">
          <div class="template-name">${t.name}</div>
          ${t.is_shared ? '<span class="badge badge-info">Shared</span>' : ''}
        </div>
        <div class="template-meta">${t.description||'No description'} · by ${t.created_by_name||'?'}</div>
        <div class="template-days">
          ${days.map((d,i) => {
            const day = t.days?.find(td=>td.day_index===i);
            const loc = day ? this.loc(day.location_id) : null;
            return `<div class="template-day-cell" style="background:${loc?loc.color+'28':'var(--bg-surface3)'};color:${loc?loc.color:'var(--text-muted)'}">${d}</div>`;
          }).join('')}
        </div>
        <div class="flex gap-2 mt-4">
          <button class="btn btn-secondary btn-sm flex-1" onclick="app.openTplModal('${t.id}')">Edit</button>
          <button class="btn btn-secondary btn-sm flex-1" onclick="app.openApplyModal('${t.id}')">Apply</button>
          <button class="btn btn-danger btn-sm" onclick="app.confirmDeleteTemplate('${t.id}')">🗑</button>
        </div>
      </div>`;
    });
    return h + '</div></div>';
  }

  async openTplModal(tplId = null) {
    const tpl = tplId ? this.templates.find(t=>t.id===tplId) : null;
    this.editTemplateData = tpl;
    document.getElementById('tpl-modal-title').textContent = tpl ? 'Edit Template' : 'Create Template';

    const DAY_NAMES = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
    let body = `
      <div class="form-group"><label>Template Name</label><input type="text" id="tpl-name" value="${tpl?.name||''}" placeholder="e.g. Standard Week"></div>
      <div class="form-group"><label>Description</label><input type="text" id="tpl-desc" value="${tpl?.description||''}" placeholder="Optional description"></div>
      <div class="form-group">
        <label style="display:flex;align-items:center;gap:8px">
          <input type="checkbox" id="tpl-shared" ${tpl?.is_shared?'checked':''}> Share with all users
        </label>
      </div>
      <div style="margin-top:16px"><div style="font-size:13px;font-weight:600;margin-bottom:10px">Daily Configuration</div>
      <div style="display:flex;flex-direction:column;gap:10px">`;

    DAY_NAMES.forEach((name, i) => {
      const day  = tpl?.days?.find(d => d.day_index === i);
      const locId = day?.location_id || '';
      body += `
        <div style="background:var(--bg-surface2);border-radius:var(--radius-sm);padding:14px;border:1px solid var(--border)">
          <div style="font-weight:600;font-size:13px;margin-bottom:8px;display:flex;align-items:center;gap:8px">
            <span>${name}</span>
            <label style="font-weight:400;font-size:12px;display:flex;align-items:center;gap:4px">
              <input type="checkbox" id="td-${i}-on" ${locId?'checked':''} onchange="app.toggleTplDay(${i})"> Enabled
            </label>
          </div>
          <div id="td-${i}-body" ${!locId?'style="display:none"':''}>
            <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px">
              <div class="form-group" style="margin:0"><label style="font-size:11px">Location</label>
                <select id="td-${i}-loc">
                  <option value="">— Select —</option>
                  ${this.locations.map(l=>`<option value="${l.id}" ${locId===l.id?'selected':''}>${l.name}</option>`).join('')}
                </select>
              </div>
              <div class="form-group" style="margin:0"><label style="font-size:11px">Start</label>
                <input type="time" id="td-${i}-start" value="${day?.start_time||'09:00'}">
              </div>
              <div class="form-group" style="margin:0"><label style="font-size:11px">End</label>
                <input type="time" id="td-${i}-end" value="${day?.end_time||'17:00'}">
              </div>
            </div>
            <div class="form-group" style="margin-top:8px;margin-bottom:4px"><label style="font-size:11px">Notes</label>
              <textarea id="td-${i}-notes" style="min-height:48px;font-size:12px">${day?.notes||''}</textarea>
            </div>
            <div>
              <label style="font-size:11px;font-weight:500">Note Colour</label>
              <div class="color-palette" style="margin-top:4px">
                ${NOTE_COLORS.map(c=>`
                  <div class="color-swatch ${day?.note_color===c.value?'selected':''}"
                    style="width:22px;height:22px;background:${c.value||'transparent'};border:2px solid ${c.value||'var(--border-strong)'}"
                    onclick="app.pickTplDayColor(this,${i},'${c.value}')" title="${c.name}">
                    ${!c.value?'<span style="font-size:10px;display:flex;align-items:center;justify-content:center;height:100%;color:var(--text-muted)">✕</span>':''}
                  </div>`).join('')}
              </div>
              <input type="hidden" id="td-${i}-color" value="${day?.note_color||''}">
            </div>
          </div>
        </div>`;
    });

    document.getElementById('tpl-modal-body').innerHTML = body + '</div></div>';
    showModal('tpl-modal');
  }

  toggleTplDay(i) {
    const on = document.getElementById(`td-${i}-on`).checked;
    document.getElementById(`td-${i}-body`).style.display = on ? '' : 'none';
  }

  pickTplDayColor(el, i, color) {
    el.closest('.color-palette').querySelectorAll('.color-swatch').forEach(s=>s.classList.remove('selected'));
    el.classList.add('selected');
    document.getElementById(`td-${i}-color`).value = color;
  }

  async saveTemplate() {
    const name = document.getElementById('tpl-name').value.trim();
    if (!name) return toast('Name required', 'error');

    const days = {};
    for (let i = 0; i < 7; i++) {
      if (!document.getElementById(`td-${i}-on`)?.checked) continue;
      const locId = document.getElementById(`td-${i}-loc`)?.value;
      if (!locId) continue;
      days[i] = {
        locationId: locId,
        startTime: document.getElementById(`td-${i}-start`)?.value || '09:00',
        endTime:   document.getElementById(`td-${i}-end`)?.value   || '17:00',
        notes:     document.getElementById(`td-${i}-notes`)?.value || '',
        noteColor: document.getElementById(`td-${i}-color`)?.value || null,
      };
    }

    try {
      const data = { name, description: document.getElementById('tpl-desc').value, isShared: document.getElementById('tpl-shared').checked, days };
      if (this.editTemplateData) {
        await api.updateTemplate(this.editTemplateData.id, data);
        toast('Template updated', 'success');
      } else {
        await api.createTemplate(data);
        toast('Template created', 'success');
      }
      hideModal('tpl-modal');
      await this.navigate('templates');
    } catch (e) { toast(e.message, 'error'); }
  }

  confirmDeleteTemplate(id) {
    this.confirm('Delete Template', 'Delete this template? Applied shifts are not affected.', async () => {
      await api.deleteTemplate(id);
      toast('Deleted', 'success');
      await this.navigate('templates');
    });
  }

  async openApplyModal(preId = null) {
    await this.refreshTemplates();
    const users = appState.isAdmin() ? (await api.getUsers().catch(()=>({users:[]}))).users : [];
    document.getElementById('apply-modal-body').innerHTML = `
      <div class="form-group"><label>Template</label>
        <select id="apply-tpl">
          ${this.templates.map(t=>`<option value="${t.id}" ${t.id===preId?'selected':''}>${t.name}</option>`).join('')}
        </select>
      </div>
      ${appState.isAdmin() ? `
      <div class="form-group"><label>User</label>
        <select id="apply-user">
          ${users.filter(u=>u.active).map(u=>`<option value="${u.id}">${u.name}</option>`).join('')}
        </select>
      </div>` : `<input type="hidden" id="apply-user" value="${appState.currentUser.id}">`}
      <div class="form-group"><label>Any day in target week</label>
        <input type="date" id="apply-date" value="${new Date().toISOString().split('T')[0]}">
      </div>
      <p class="text-muted text-sm">The Mon–Sun week containing the selected date will be populated.</p>`;
    showModal('apply-modal');
  }

  async doApplyTemplate() {
    const id   = document.getElementById('apply-tpl').value;
    const date = document.getElementById('apply-date').value;
    const userId = document.getElementById('apply-user').value;
    if (!id || !date) return toast('Fill all fields', 'error');
    try {
      const r = await api.applyTemplate(id, { date, userId });
      toast(`Template applied — ${r.created} shifts created`, 'success');
      hideModal('apply-modal');
      await this.refreshShifts();
      const grid = document.getElementById('cal-grid');
      if (grid) grid.innerHTML = this.renderGrid();
    } catch (e) { toast(e.message, 'error'); }
  }

  // ── Locations ─────────────────────────────────────────────────────────────

  tplLocationsPage() {
    return `<div class="page-content">
      <div class="page-header"><div><h2>Locations</h2><p class="text-muted text-sm">Work sites and locations</p></div></div>
      <div class="card"><div class="table-wrapper"><table>
        <thead><tr><th>Name</th><th>Address</th><th>Colour</th><th>Actions</th></tr></thead>
        <tbody>
          ${this.locations.map(l=>`<tr>
            <td><div class="flex items-center gap-2"><div class="loc-dot" style="background:${l.color}"></div><strong>${l.name}</strong></div></td>
            <td>${l.address||'—'}</td>
            <td><code style="font-family:var(--font-mono);font-size:12px">${l.color}</code></td>
            <td><div class="flex gap-2">
              <button class="btn btn-secondary btn-sm" onclick="app.openLocModal('${l.id}')">Edit</button>
              <button class="btn btn-danger btn-sm" onclick="app.confirmDeleteLoc('${l.id}')">Delete</button>
            </div></td>
          </tr>`).join('')}
        </tbody>
      </table></div></div>
    </div>`;
  }

  openLocModal(locId = null) {
    const loc = locId ? this.locations.find(l=>l.id===locId) : null;
    document.getElementById('loc-modal-title').textContent = loc ? 'Edit Location' : 'Add Location';
    document.getElementById('loc-modal-body').innerHTML = `
      <div class="form-group"><label>Name</label><input type="text" id="lm-name" value="${loc?.name||''}"></div>
      <div class="form-group"><label>Address</label><input type="text" id="lm-address" value="${loc?.address||''}"></div>
      <div class="form-group"><label>Colour</label><input type="color" id="lm-color" value="${loc?.color||'#3b82f6'}" style="width:60px;height:38px;padding:2px;cursor:pointer"></div>
      <input type="hidden" id="lm-id" value="${locId||''}">`;
    showModal('loc-modal');
  }

  async saveLocation() {
    const id      = document.getElementById('lm-id').value;
    const name    = document.getElementById('lm-name').value.trim();
    const address = document.getElementById('lm-address').value.trim();
    const color   = document.getElementById('lm-color').value;
    if (!name) return toast('Name required', 'error');
    try {
      if (id) { await api.updateLocation(id, { name, address, color }); toast('Updated', 'success'); }
      else    { await api.createLocation({ name, address, color }); toast('Location added', 'success'); }
      hideModal('loc-modal');
      this.locations = (await api.getLocations()).locations;
      await this.navigate('locations');
    } catch (e) { toast(e.message, 'error'); }
  }

  confirmDeleteLoc(id) {
    this.confirm('Delete Location', 'Delete this location? Existing shifts will lose their location reference.', async () => {
      await api.deleteLocation(id);
      this.locations = (await api.getLocations()).locations;
      toast('Deleted', 'success');
      await this.navigate('locations');
    });
  }

  // ── Users ─────────────────────────────────────────────────────────────────

  async refreshUsers() {
    try { this.users = (await api.getUsers()).users || []; }
    catch { this.users = []; }
  }

  tplUsersPage() {
    return `<div class="page-content">
      <div class="page-header"><div><h2>Users</h2><p class="text-muted text-sm">${this.users.length} total accounts</p></div></div>
      <div class="card"><div class="table-wrapper"><table>
        <thead><tr><th>User</th><th>Email</th><th>Role</th><th>Status</th><th>Joined</th><th>Actions</th></tr></thead>
        <tbody>
          ${this.users.map(u=>`<tr>
            <td><div class="flex items-center gap-2">
              <div class="user-avatar" style="width:30px;height:30px;font-size:12px">${(u.name||'U').charAt(0)}</div>
              <div><div style="font-weight:600;font-size:13px">${u.name}</div><div style="font-size:11px;color:var(--text-muted)">@${u.username}</div></div>
            </div></td>
            <td style="font-size:13px">${u.email}</td>
            <td><span class="badge ${u.role==='admin'?'badge-accent':'badge-muted'}">${u.role}</span></td>
            <td><span class="badge ${u.active?'badge-success':'badge-danger'}">${u.active?'Active':'Inactive'}</span></td>
            <td style="font-size:12px;color:var(--text-muted)">${new Date(u.created_at).toLocaleDateString('en-GB')}</td>
            <td><div class="flex gap-2">
              <button class="btn btn-secondary btn-sm" onclick="app.openUserModal('${u.id}')">Edit</button>
              <button class="btn btn-secondary btn-sm" onclick="app.promptResetPw('${u.id}')">Reset PW</button>
              <button class="btn btn-sm" style="background:${u.active?'var(--warning-light)':'var(--success-light)'};color:${u.active?'var(--warning)':'var(--success)'};border:none"
                onclick="app.toggleActive('${u.id}',${u.active})">${u.active?'Deactivate':'Activate'}</button>
              ${u.id!==appState.currentUser.id?`<button class="btn btn-danger btn-sm" onclick="app.confirmDeleteUser('${u.id}')">Delete</button>`:''}
            </div></td>
          </tr>`).join('')}
        </tbody>
      </table></div></div>
    </div>`;
  }

  openUserModal(userId = null) {
    const user = userId ? this.users.find(u=>u.id===userId) : null;
    document.getElementById('user-modal-title').textContent = user ? 'Edit User' : 'Create User';
    document.getElementById('user-modal-body').innerHTML = `
      <div class="form-group"><label>Full Name</label><input type="text" id="um-name" value="${user?.name||''}"></div>
      <div class="form-group"><label>Username</label><input type="text" id="um-username" value="${user?.username||''}" ${user?'disabled style="opacity:.6"':''}></div>
      <div class="form-group"><label>Email</label><input type="email" id="um-email" value="${user?.email||''}"></div>
      ${!user?`<div class="form-group"><label>Password</label><input type="password" id="um-pw" placeholder="Min 8 characters"></div>`:''}
      <div class="form-group"><label>Role</label>
        <select id="um-role">
          <option value="user" ${user?.role==='user'?'selected':''}>User</option>
          <option value="admin" ${user?.role==='admin'?'selected':''}>Admin</option>
        </select>
      </div>
      <input type="hidden" id="um-id" value="${userId||''}">`;
    showModal('user-modal');
  }

  async saveUser() {
    const id   = document.getElementById('um-id').value;
    const name = document.getElementById('um-name').value.trim();
    const username = document.getElementById('um-username').value.trim();
    const email = document.getElementById('um-email').value.trim();
    const role  = document.getElementById('um-role').value;
    if (!name || !email) return toast('Fill required fields', 'error');
    try {
      if (id) {
        await api.updateUser(id, { name, email, role });
        toast('User updated', 'success');
      } else {
        const password = document.getElementById('um-pw').value;
        if (!password) return toast('Password required', 'error');
        await api.createUser({ name, username, email, password, role });
        toast('User created', 'success');
      }
      hideModal('user-modal');
      await this.refreshUsers();
      await this.navigate('users');
    } catch (e) { toast(e.message, 'error'); }
  }

  async toggleActive(id, active) {
    await api.updateUser(id, { active: !active });
    toast(active ? 'User deactivated' : 'User activated', active ? 'warning' : 'success');
    await this.refreshUsers();
    await this.navigate('users');
  }

  async promptResetPw(id) {
    const pw = prompt('Enter new password (min 8 chars):');
    if (!pw) return;
    try {
      await api.resetPassword(id, pw);
      toast('Password reset', 'success');
    } catch (e) { toast(e.message, 'error'); }
  }

  confirmDeleteUser(id) {
    this.confirm('Delete User', 'Permanently delete this user and all their shifts?', async () => {
      await api.deleteUser(id);
      toast('User deleted', 'success');
      await this.refreshUsers();
      await this.navigate('users');
    });
  }

  // ── Settings ──────────────────────────────────────────────────────────────

  // ── Version info helper ──────────────────────────────────────────────────
  _tplVersionRows() {
    const s = appState;
    const ENV_COLORS = {
      production:  'var(--success)',
      staging:     'var(--warning)',
      development: 'var(--danger)',
    };
    const envColor = ENV_COLORS[s.environment] || 'var(--accent)';

    const builtAt = s.builtAt
      ? new Date(s.builtAt).toLocaleString('en-GB', {
          day:'2-digit', month:'short', year:'numeric',
          hour:'2-digit', minute:'2-digit'
        })
      : '—';

    const row = (label, value, mono = false) => `
      <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--border)">
        <span style="font-size:12px;color:var(--text-muted);font-weight:500">${label}</span>
        <span style="${mono ? 'font-family:var(--font-mono);' : ''}font-size:13px;font-weight:600;color:var(--text-primary)">${value}</span>
      </div>`;

    const envBadge = `<span style="
      display:inline-block;padding:2px 10px;border-radius:20px;
      background:${envColor}22;color:${envColor};
      font-size:12px;font-weight:700;letter-spacing:.04em;text-transform:uppercase
    ">${s.envLabel}</span>`;

    return `
      <div style="margin-bottom:4px">
        ${row('Application', '<strong>ForgeShift</strong>')}
        ${row('Environment', envBadge)}
        ${row('Version', `v${s.version}`)}
        ${row('Build', s.build > 0 ? `#${s.build}` : '—', true)}
        ${row('Commit', s.commit !== 'local' ? `<a href="https://github.com/YOUR_ORG/forgeshift/commit/${s.commit}" target="_blank" rel="noopener" style="color:var(--accent);text-decoration:none">${s.commit}</a>` : '—', true)}
        ${row('Branch', s.branch || '—', true)}
        <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0">
          <span style="font-size:12px;color:var(--text-muted);font-weight:500">Built at</span>
          <span style="font-size:13px;color:var(--text-primary)">${builtAt}</span>
        </div>
      </div>
      <p style="font-size:11px;color:var(--text-muted);margin-top:8px">Node.js · Express · SQLite · PM2</p>`;
  }

  async tplSettingsPage() {
    const settings = (await api.getSettings().catch(() => ({ settings: {} }))).settings;
    const allowSignup = settings.allow_signup === 'true';

    return `<div class="page-content">
      <div class="page-header"><h2>Settings</h2></div>
      <div class="settings-grid">
        <div>
          <div class="card"><div class="card-header"><span class="card-title">Appearance</span></div>
            <div class="card-body">
              <div style="font-size:13px;font-weight:500;margin-bottom:8px">Theme</div>
              <div class="theme-selector">
                <button class="theme-option ${appState.theme==='auto'?'active':''}" onclick="app.setTheme('auto')">🌗 Auto</button>
                <button class="theme-option ${appState.theme==='light'?'active':''}" onclick="app.setTheme('light')">☀️ Light</button>
                <button class="theme-option ${appState.theme==='dark'?'active':''}" onclick="app.setTheme('dark')">🌙 Dark</button>
                <button class="theme-option ${appState.theme==='oled'?'active':''}" onclick="app.setTheme('oled')">⬛ OLED</button>
              </div>
            </div>
          </div>

          <div class="card mt-4"><div class="card-header"><span class="card-title">Registration</span></div>
            <div class="card-body">
              <div class="settings-row">
                <div class="settings-row-info">
                  <div class="settings-row-label">Allow Public Sign-Up</div>
                  <div class="settings-row-desc">When off, the sign-up link disappears from the login page</div>
                </div>
                <div class="toggle ${allowSignup?'on':''}" id="signup-toggle" onclick="app.toggleSignup(this)"></div>
              </div>
            </div>
          </div>
        </div>

        <div>
          <div class="card">
            <div class="card-header"><span class="card-title">Environment &amp; Version</span></div>
            <div class="card-body">
              \${this._tplVersionRows()}
            </div>
          </div>
        </div>
      </div>
    </div>`;
  }

  async toggleSignup(el) {
    const isOn = el.classList.contains('on');
    await api.setSetting('allow_signup', !isOn ? 'true' : 'false');
    el.classList.toggle('on', !isOn);
    toast(`Sign-up ${!isOn ? 'enabled' : 'disabled'}`, 'success');
  }

  setTheme(theme) {
    appState.setTheme(theme);
    document.querySelectorAll('.theme-option').forEach(b => {
      b.classList.toggle('active', b.textContent.toLowerCase().includes(theme));
    });
    toast(`Theme: ${theme}`, 'success');
  }

  // ── Profile ───────────────────────────────────────────────────────────────

  tplProfilePage() {
    const u = appState.currentUser;
    return `<div class="page-content" style="max-width:640px">
      <div class="page-header"><h2>My Profile</h2></div>

      <!-- ── Personal details ── -->
      <div class="card">
        <div class="card-body">
          <div class="flex items-center gap-3 mb-4" style="padding-bottom:16px;border-bottom:1px solid var(--border)">
            <div class="user-avatar" style="width:54px;height:54px;font-size:22px">${(u?.name||'U').charAt(0)}</div>
            <div>
              <div style="font-size:18px;font-weight:700">${u?.name}</div>
              <div style="font-size:13px;color:var(--text-muted)">@${u?.username} · ${u?.role}</div>
            </div>
          </div>
          <div class="form-group"><label>Full Name</label><input type="text" id="pf-name" value="${u?.name||''}"></div>
          <div class="form-group"><label>Email</label><input type="email" id="pf-email" value="${u?.email||''}"></div>
          <div class="form-group"><label>Username</label><input type="text" value="${u?.username||''}" disabled style="opacity:.6"></div>
          <button class="btn btn-primary" onclick="app.saveProfile()">Save Changes</button>
        </div>
      </div>

      <!-- ── Change password ── -->
      <div class="card mt-4">
        <div class="card-header"><span class="card-title">Change Password</span></div>
        <div class="card-body">
          <div class="form-group"><label>Current Password</label><input type="password" id="pw-cur" placeholder="Current password"></div>
          <div class="form-group"><label>New Password</label><input type="password" id="pw-new" placeholder="New password (min 8 chars)"></div>
          <div class="form-group"><label>Confirm New Password</label><input type="password" id="pw-cfm" placeholder="Confirm new password"></div>
          <button class="btn btn-primary" onclick="app.changePassword()">Update Password</button>
        </div>
      </div>

      <!-- ── iCal feeds ── -->
      <div class="card mt-4" id="ical-card">
        <div class="card-header">
          <span class="card-title">📅 iCal / Calendar Feeds</span>
          <span class="badge badge-info">Subscribe in any calendar app</span>
        </div>
        <div class="card-body" id="ical-body">
          <div style="display:flex;align-items:center;gap:10px;padding:20px 0">
            <div class="spinner"></div><span style="font-size:13px;color:var(--text-muted)">Loading…</span>
          </div>
        </div>
      </div>

      <!-- ── Appearance ── -->
      <div class="card mt-4">
        <div class="card-header"><span class="card-title">Appearance</span></div>
        <div class="card-body">
          <div class="theme-selector">
            <button class="theme-option ${appState.theme==='auto'?'active':''}" onclick="app.setTheme('auto')">🌗 Auto</button>
            <button class="theme-option ${appState.theme==='light'?'active':''}" onclick="app.setTheme('light')">☀️ Light</button>
            <button class="theme-option ${appState.theme==='dark'?'active':''}" onclick="app.setTheme('dark')">🌙 Dark</button>
            <button class="theme-option ${appState.theme==='oled'?'active':''}" onclick="app.setTheme('oled')">⬛ OLED</button>
          </div>
        </div>
      </div>

      <div class="mt-4">
        <button class="btn btn-danger" onclick="app.doLogout()">Sign Out</button>
      </div>
    </div>`;
  }

  async loadIcalSection() {
    const body = document.getElementById('ical-body');
    if (!body) return;
    try {
      const { hasToken, createdAt, lastUsed } = await api.getIcalToken();
      const origin = window.location.origin;
      const isAdmin = appState.isAdmin();

      if (!hasToken) {
        body.innerHTML = `
          <p style="font-size:13px;color:var(--text-secondary);margin-bottom:16px">
            Generate a personal iCal token to subscribe to your shift rota in Google Calendar, Apple Calendar, Outlook, or any CalDAV app.
            The feed URL contains your token — keep it private.
          </p>
          <button class="btn btn-primary" onclick="app.generateIcalToken()">Generate iCal Token</button>`;
        return;
      }

      const createdFmt = createdAt ? new Date(createdAt).toLocaleDateString('en-GB', {day:'numeric',month:'short',year:'numeric'}) : '—';
      const usedFmt    = lastUsed  ? new Date(lastUsed).toLocaleDateString('en-GB',  {day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'}) : 'Never';

      body.innerHTML = `
        <p style="font-size:13px;color:var(--text-secondary);margin-bottom:16px">
          Copy a feed URL below and paste it into your calendar app as a <strong>subscribed calendar</strong>.
          Feeds refresh automatically — shifts appear within an hour of being added.
        </p>

        <div style="display:flex;flex-direction:column;gap:10px;margin-bottom:20px" id="ical-feeds">
          <div style="background:var(--bg-surface2);border:1px solid var(--border);border-radius:var(--radius-sm);padding:14px">
            <div style="font-size:12px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px">
              📅 My Shifts
            </div>
            <div style="font-size:12px;color:var(--text-muted);margin-bottom:8px">Your personal rota — 3 months past, 12 months ahead</div>
            <div style="display:flex;gap:8px;align-items:center">
              <code id="url-personal" style="font-family:var(--font-mono);font-size:11px;color:var(--accent);background:var(--accent-light);padding:6px 10px;border-radius:4px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
                Loading…
              </code>
              <button class="btn btn-secondary btn-sm" onclick="app.copyIcalUrl('url-personal')">Copy</button>
            </div>
          </div>

          ${isAdmin ? `
          <div style="background:var(--bg-surface2);border:1px solid var(--border);border-radius:var(--radius-sm);padding:14px">
            <div style="font-size:12px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px">
              👥 Full Team Feed <span class="badge badge-accent" style="margin-left:4px">Admin</span>
            </div>
            <div style="font-size:12px;color:var(--text-muted);margin-bottom:8px">All users' shifts — names included in event titles</div>
            <div style="display:flex;gap:8px;align-items:center">
              <code id="url-team" style="font-family:var(--font-mono);font-size:11px;color:var(--accent);background:var(--accent-light);padding:6px 10px;border-radius:4px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
                Loading…
              </code>
              <button class="btn btn-secondary btn-sm" onclick="app.copyIcalUrl('url-team')">Copy</button>
            </div>
          </div>` : ''}
        </div>

        <div style="display:flex;gap:16px;align-items:center;padding-top:14px;border-top:1px solid var(--border);flex-wrap:wrap">
          <div style="font-size:12px;color:var(--text-muted)">
            Token created: <strong>${createdFmt}</strong> &nbsp;·&nbsp; Last used: <strong>${usedFmt}</strong>
          </div>
          <div style="margin-left:auto;display:flex;gap:8px">
            <button class="btn btn-secondary btn-sm" onclick="app.generateIcalToken(true)">Regenerate Token</button>
            <button class="btn btn-danger btn-sm" onclick="app.revokeIcalToken()">Revoke</button>
          </div>
        </div>

        <div style="margin-top:16px;padding:12px 14px;background:var(--bg-surface3);border-radius:var(--radius-sm);font-size:12px;color:var(--text-muted)">
          <strong>How to subscribe:</strong>
          <span style="display:inline-block;margin-top:4px">
            <strong>Google Calendar:</strong> Other calendars → + → From URL &nbsp;|&nbsp;
            <strong>Apple Calendar:</strong> File → New Calendar Subscription &nbsp;|&nbsp;
            <strong>Outlook:</strong> Add calendar → Subscribe from web
          </span>
        </div>`;

      // Now fetch the actual token to build URLs
      const { token } = await api.generateIcalToken();
      // Store token in hidden field for copy use
      const personalUrl = `${origin}/api/ical/${token}/my-shifts.ics`;
      const teamUrl     = `${origin}/api/ical/${token}/team.ics`;

      const pEl = document.getElementById('url-personal');
      if (pEl) pEl.textContent = personalUrl;

      if (isAdmin) {
        const tEl = document.getElementById('url-team');
        if (tEl) tEl.textContent = teamUrl;
      }

      // Re-load token info since we just regenerated
      await api.getIcalToken();

    } catch (e) {
      if (body) body.innerHTML = `<p class="text-muted text-sm">Could not load iCal info: ${e.message}</p>`;
    }
  }

  async generateIcalToken(confirm = false) {
    if (confirm) {
      const ok = window.confirm('Regenerating your token will invalidate all existing calendar subscriptions. Continue?');
      if (!ok) return;
    }
    try {
      await api.generateIcalToken();
      toast('Token generated', 'success');
      await this.loadIcalSection();
    } catch (e) { toast(e.message, 'error'); }
  }

  async revokeIcalToken() {
    this.confirm('Revoke iCal Token', 'This will break all existing calendar subscriptions. Continue?', async () => {
      await api.revokeIcalToken();
      toast('Token revoked', 'success');
      await this.loadIcalSection();
    });
  }

  copyIcalUrl(elId) {
    const el = document.getElementById(elId);
    if (!el) return;
    navigator.clipboard.writeText(el.textContent.trim())
      .then(() => toast('URL copied to clipboard', 'success'))
      .catch(() => {
        // Fallback for non-HTTPS
        const ta = document.createElement('textarea');
        ta.value = el.textContent.trim();
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
        toast('URL copied', 'success');
      });
  }

  async saveProfile() {
    const name  = document.getElementById('pf-name').value.trim();
    const email = document.getElementById('pf-email').value.trim();
    if (!name || !email) return toast('Name and email required', 'error');
    try {
      await api.updateMe({ name, email });
      appState.currentUser.name  = name;
      appState.currentUser.email = email;
      toast('Profile saved', 'success');
      // refresh sidebar display
      const uname = document.querySelector('.sidebar .user-name');
      const avt   = document.querySelector('.sidebar .user-avatar');
      if (uname) uname.textContent = name;
      if (avt)   avt.textContent = name.charAt(0).toUpperCase();
    } catch (e) { toast(e.message, 'error'); }
  }

  async changePassword() {
    const cur = document.getElementById('pw-cur').value;
    const nw  = document.getElementById('pw-new').value;
    const cfm = document.getElementById('pw-cfm').value;
    if (!cur || !nw || !cfm) return toast('Fill all fields', 'error');
    if (nw !== cfm) return toast('Passwords do not match', 'error');
    try {
      await api.changeMyPassword({ currentPassword: cur, newPassword: nw });
      toast('Password changed', 'success');
      document.getElementById('pw-cur').value = '';
      document.getElementById('pw-new').value = '';
      document.getElementById('pw-cfm').value = '';
    } catch (e) { toast(e.message, 'error'); }
  }

  async doLogout() {
    await api.logout().catch(() => {});
    appState.currentUser = null;
    await this.mountAuth('login');
  }

  // ── Utilities ─────────────────────────────────────────────────────────────

  toggleSidebar() {
    document.getElementById('sidebar').classList.toggle('open');
    document.getElementById('sidebar-backdrop').classList.toggle('open');
  }
  closeSidebar() {
    document.getElementById('sidebar')?.classList.remove('open');
    document.getElementById('sidebar-backdrop')?.classList.remove('open');
  }

  confirm(title, msg, onOk) {
    document.getElementById('confirm-title').textContent = title;
    document.getElementById('confirm-msg').textContent   = msg;
    const btn = document.getElementById('confirm-ok');
    btn.onclick = () => { hideModal('confirm-modal'); onOk(); };
    showModal('confirm-modal');
  }
}

window.app = new RotaApp();
