// ── App State ─────────────────────────────────────────────────────────────

class AppState {
  constructor() {
    this.currentUser  = null;
    this.theme        = localStorage.getItem('theme') || 'auto';
    this.environment  = 'production';
    this.version      = '1.0.0';
    this.build        = 0;
    this.commit       = 'local';
    this.branch       = 'main';
    this.builtAt      = null;
    this.listeners    = {};
  }

  on(event, cb) {
    if (!this.listeners[event]) this.listeners[event] = [];
    this.listeners[event].push(cb);
  }
  emit(event, data) {
    (this.listeners[event] || []).forEach(cb => cb(data));
  }

  // Human-readable label: "v1.0.0 · build 42"
  get versionLabel() {
    return this.build > 0
      ? `v${this.version} · build ${this.build}`
      : `v${this.version}`;
  }

  // Short label for tight spaces: "v1.0.0 #42"
  get versionShort() {
    return this.build > 0 ? `v${this.version} #${this.build}` : `v${this.version}`;
  }

  // Environment display name with capitalised first letter
  get envLabel() {
    return this.environment.charAt(0).toUpperCase() + this.environment.slice(1);
  }

  async init() {
    // Apply theme before anything renders
    this.applyTheme();

    // Fetch environment + version from server config
    try {
      const cfg = await fetch('/api/config').then(r => r.json());
      this.environment = cfg.environment || 'production';
      this.version     = cfg.version     || '1.0.0';
      this.build       = cfg.build       || 0;
      this.commit      = cfg.commit      || 'local';
      this.branch      = cfg.branch      || 'main';
      this.builtAt     = cfg.builtAt     || null;
      this._applyEnvBar();
    } catch { this.environment = 'production'; }

    // Try to restore session
    try {
      const { user } = await api.getMe();
      this.currentUser = user;
    } catch {
      this.currentUser = null;
    }
  }

  _applyEnvBar() {
    const bar = document.getElementById('env-bar');
    const lbl = document.getElementById('env-label');
    if (bar) bar.className = `env-bar ${this.environment}`;
    if (lbl) {
      // Show: "Production · v1.0.0 #42"  or just "Development · v1.0.0 #42"
      lbl.textContent = `${this.envLabel} · ${this.versionShort}`;
    }
  }

  applyTheme() {
    const root = document.documentElement;
    root.removeAttribute('data-theme');
    if (this.theme === 'dark')  root.setAttribute('data-theme', 'dark');
    if (this.theme === 'oled')  root.setAttribute('data-theme', 'oled');
    if (this.theme === 'light') root.setAttribute('data-theme', 'light');
  }

  setTheme(theme) {
    this.theme = theme;
    localStorage.setItem('theme', theme);
    this.applyTheme();
  }

  isAdmin() { return this.currentUser?.role === 'admin'; }
}

window.appState = new AppState();
