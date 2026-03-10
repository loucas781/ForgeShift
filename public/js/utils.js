// ── Helpers ───────────────────────────────────────────────────────────────

const NOTE_COLORS = [
  { name: 'None',   value: '' },
  { name: 'Blue',   value: '#3b82f6' },
  { name: 'Green',  value: '#10b981' },
  { name: 'Amber',  value: '#f59e0b' },
  { name: 'Red',    value: '#ef4444' },
  { name: 'Purple', value: '#8b5cf6' },
  { name: 'Pink',   value: '#ec4899' },
  { name: 'Teal',   value: '#14b8a6' },
  { name: 'Orange', value: '#f97316' },
];

function toast(message, type = 'info') {
  const c = document.getElementById('toast-container');
  if (!c) return;
  const icons = { success: '✓', error: '✕', warning: '⚠', info: 'ℹ' };
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<span class="toast-icon">${icons[type]||'ℹ'}</span><span>${message}</span>`;
  c.appendChild(el);
  setTimeout(() => { el.classList.add('leaving'); setTimeout(() => el.remove(), 200); }, 3500);
}

function showModal(id) { document.getElementById(id)?.classList.remove('hidden'); }
function hideModal(id) { document.getElementById(id)?.classList.add('hidden'); }

function fmtTime(t) {
  if (!t) return '';
  const [h, m] = t.split(':');
  const hh = parseInt(h);
  return `${hh > 12 ? hh - 12 : hh || 12}:${m}${hh >= 12 ? 'pm' : 'am'}`;
}

function fmtDate(s) {
  if (!s) return '';
  const d = new Date(s + 'T00:00:00');
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
}

function colorPalette(selectedValue, onSelect) {
  return NOTE_COLORS.map(c => `
    <div class="color-swatch ${selectedValue === c.value ? 'selected' : ''}"
      style="background:${c.value||'transparent'};border:2px solid ${c.value||'var(--border-strong)'}"
      onclick="${onSelect}(this,'${c.value}')" title="${c.name}">
      ${!c.value ? '<span style="font-size:13px;display:flex;align-items:center;justify-content:center;height:100%;color:var(--text-muted)">✕</span>' : ''}
    </div>`).join('');
}

// ── Calendar Engine ───────────────────────────────────────────────────────

class CalendarEngine {
  constructor() {
    this.view = 'month';
    this.date = new Date();
    if (this.view === 'month') this.date.setDate(1);
  }

  getMonthGrid(year, month) {
    const days = [];
    const firstDay = new Date(year, month, 1).getDay();
    const totalDays = new Date(year, month + 1, 0).getDate();
    const prevTotal = new Date(year, month, 0).getDate();
    const startPad = firstDay === 0 ? 6 : firstDay - 1;

    for (let i = startPad - 1; i >= 0; i--)
      days.push({ day: prevTotal - i, month: month - 1, year, other: true });
    for (let d = 1; d <= totalDays; d++)
      days.push({ day: d, month, year, other: false });
    const cells = Math.ceil(days.length / 7) * 7;
    let next = 1;
    while (days.length < cells)
      days.push({ day: next++, month: month + 1, year, other: true });
    return days;
  }

  getWeekDays(date) {
    const d = new Date(date);
    const day = d.getDay();
    const mon = new Date(d);
    mon.setDate(d.getDate() - (day === 0 ? 6 : day - 1));
    return Array.from({ length: 7 }, (_, i) => {
      const dd = new Date(mon);
      dd.setDate(mon.getDate() + i);
      return dd;
    });
  }

  navigate(dir) {
    if (this.view === 'month') this.date.setMonth(this.date.getMonth() + dir);
    else if (this.view === 'week') this.date.setDate(this.date.getDate() + dir * 7);
    else this.date.setDate(this.date.getDate() + dir);
  }

  goToday() {
    this.date = new Date();
    if (this.view === 'month') this.date.setDate(1);
  }

  title() {
    const d = this.date;
    if (this.view === 'month')
      return d.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
    if (this.view === 'week') {
      const days = this.getWeekDays(d);
      return 'Week of ' + days[0].toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
    }
    return d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  }

  isoDate(year, month, day) {
    return `${year}-${String(month + 1).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
  }

  isToday(year, month, day) {
    const n = new Date();
    return n.getFullYear() === year && n.getMonth() === month && n.getDate() === day;
  }

  formatDate(d) {
    return d.toISOString().split('T')[0];
  }
}

window.CalendarEngine = CalendarEngine;
window.toast = toast;
window.showModal = showModal;
window.hideModal = hideModal;
window.fmtTime = fmtTime;
window.fmtDate = fmtDate;
window.colorPalette = colorPalette;
window.NOTE_COLORS = NOTE_COLORS;
