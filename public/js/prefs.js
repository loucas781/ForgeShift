/* prefs.js — user preferences and holiday calendar data
 * Preferences are stored server-side (per user) and cached in memory.
 * Holiday data is static JS — no external API, works offline.
 */
'use strict'

// ── Defaults ──────────────────────────────────────────────────────────────────
const PREFS_DEFAULTS = {
  weekStartDay:      1,      // 0 = Sunday, 1 = Monday
  defaultView:       'month',
  showWeekNumbers:   false,
  holidays:          [],     // array of holiday set IDs to show
  defaultShiftStart: '',     // e.g. '09:00'
  defaultShiftEnd:   '',
  compactChips:      false,
  shiftPanelSide:    'right', // 'left' | 'right'
}
const PREFS_DEFAULT_VIEWS = ['month', 'week', 'agenda']

let _prefs = null

function mergePrefs(data) {
  const merged = { ...PREFS_DEFAULTS, ...(data || {}) }
  if (!PREFS_DEFAULT_VIEWS.includes(merged.defaultView)) merged.defaultView = PREFS_DEFAULTS.defaultView
  return merged
}

async function loadPrefs() {
  if (_prefs) return _prefs
  try {
    const data = await api('/api/auth/prefs')
    _prefs = mergePrefs(data)
  } catch {
    _prefs = { ...PREFS_DEFAULTS }
  }
  return _prefs
}

async function savePrefs(updates) {
  try {
    const data = await api('/api/auth/prefs', { method: 'PATCH', body: updates })
    _prefs = mergePrefs(data)
    return _prefs
  } catch (err) {
    toast(err.message || 'Failed to save preferences', 'error')
    return _prefs
  }
}

function getPrefs() {
  return _prefs || { ...PREFS_DEFAULTS }
}

// ── Holiday sets ───────────────────────────────────────────────────────────────
// Each entry: { id, label, region, emoji, holidays: [{month (1-based), day, name}] }
// For moveable feasts (Easter, Thanksgiving, etc.) we provide a getYear(y) function.

const HOLIDAY_SETS = [
  // ── UK ───────────────────────────────────────────────────────────────────────
  {
    id: 'uk-bank',
    label: 'UK Bank Holidays',
    region: 'United Kingdom',
    emoji: '🇬🇧',
    fixed: [
      { month: 1,  day: 1,  name: "New Year's Day" },
      { month: 12, day: 25, name: 'Christmas Day' },
      { month: 12, day: 26, name: 'Boxing Day' },
    ],
    getYear(y) {
      const days = []
      // Easter Sunday (Anonymous Gregorian algorithm)
      const a = y % 19, b = Math.floor(y/100), c = y % 100
      const d = Math.floor(b/4), e = b % 4, f = Math.floor((b+8)/25)
      const g = Math.floor((b-f+1)/3), h = (19*a+b-d-g+15) % 30
      const i = Math.floor(c/4), k = c % 4
      const l = (32+2*e+2*i-h-k) % 7
      const m = Math.floor((a+11*h+22*l)/451)
      const month = Math.floor((h+l-7*m+114)/31)
      const day   = ((h+l-7*m+114) % 31) + 1
      const easter = new Date(y, month-1, day)
      // Good Friday
      const gf = new Date(easter); gf.setDate(gf.getDate() - 2)
      days.push({ month: gf.getMonth()+1, day: gf.getDate(), name: 'Good Friday' })
      // Easter Monday
      const em = new Date(easter); em.setDate(em.getDate() + 1)
      days.push({ month: em.getMonth()+1, day: em.getDate(), name: 'Easter Monday' })
      // Early May Bank Holiday (first Monday in May)
      const may1 = new Date(y, 4, 1)
      const mayMon = (8 - may1.getDay()) % 7
      days.push({ month: 5, day: 1 + mayMon, name: 'Early May Bank Holiday' })
      // Spring Bank Holiday (last Monday in May)
      const may31 = new Date(y, 4, 31)
      const springDiff = may31.getDay() === 1 ? 0 : (may31.getDay() === 0 ? 6 : may31.getDay() - 1)
      days.push({ month: 5, day: 31 - springDiff, name: 'Spring Bank Holiday' })
      // Summer Bank Holiday (last Monday in August)
      const aug31 = new Date(y, 7, 31)
      const sumDiff = aug31.getDay() === 1 ? 0 : (aug31.getDay() === 0 ? 6 : aug31.getDay() - 1)
      days.push({ month: 8, day: 31 - sumDiff, name: 'Summer Bank Holiday' })
      return days
    },
  },

  // ── US ───────────────────────────────────────────────────────────────────────
  {
    id: 'us-federal',
    label: 'US Federal Holidays',
    region: 'United States',
    emoji: '🇺🇸',
    fixed: [
      { month: 1,  day: 1,  name: "New Year's Day" },
      { month: 7,  day: 4,  name: 'Independence Day' },
      { month: 11, day: 11, name: "Veterans Day" },
      { month: 12, day: 25, name: 'Christmas Day' },
    ],
    getYear(y) {
      const days = []
      // MLK Day — 3rd Monday in January
      days.push(_nthWeekday(y, 1, 1, 3, 'Martin Luther King Jr. Day'))
      // Presidents' Day — 3rd Monday in February
      days.push(_nthWeekday(y, 2, 1, 3, "Presidents' Day"))
      // Memorial Day — last Monday in May
      days.push(_lastWeekday(y, 5, 1, 'Memorial Day'))
      // Labor Day — 1st Monday in September
      days.push(_nthWeekday(y, 9, 1, 1, 'Labor Day'))
      // Columbus Day — 2nd Monday in October
      days.push(_nthWeekday(y, 10, 1, 2, 'Columbus Day'))
      // Thanksgiving — 4th Thursday in November
      days.push(_nthWeekday(y, 11, 4, 4, 'Thanksgiving Day'))
      return days
    },
  },

  // ── EU / Christian ────────────────────────────────────────────────────────────
  {
    id: 'christian',
    label: 'Christian / Western holidays',
    region: 'International',
    emoji: '✝️',
    fixed: [
      { month: 12, day: 24, name: 'Christmas Eve' },
      { month: 12, day: 25, name: 'Christmas Day' },
      { month: 12, day: 26, name: "St Stephen's Day / Boxing Day" },
      { month: 12, day: 31, name: "New Year's Eve" },
      { month: 1,  day: 1,  name: "New Year's Day" },
      { month: 2,  day: 14, name: "Valentine's Day" },
      { month: 10, day: 31, name: 'Halloween' },
    ],
    getYear(y) {
      const days = []
      const easter = _easterSunday(y)
      days.push({ month: easter.getMonth()+1, day: easter.getDate(), name: 'Easter Sunday' })
      const gf = new Date(easter); gf.setDate(gf.getDate()-2)
      days.push({ month: gf.getMonth()+1, day: gf.getDate(), name: 'Good Friday' })
      const em = new Date(easter); em.setDate(em.getDate()+1)
      days.push({ month: em.getMonth()+1, day: em.getDate(), name: 'Easter Monday' })
      // Shrove Tuesday (Pancake Day)
      const st = new Date(easter); st.setDate(st.getDate()-47)
      days.push({ month: st.getMonth()+1, day: st.getDate(), name: 'Shrove Tuesday' })
      // Mothers Day UK (4th Sunday in Lent = 3 weeks before Easter)
      const md = new Date(easter); md.setDate(md.getDate()-21)
      days.push({ month: md.getMonth()+1, day: md.getDate(), name: "Mothering Sunday" })
      return days
    },
  },

  // ── Chinese Lunar ─────────────────────────────────────────────────────────────
  {
    id: 'chinese',
    label: 'Chinese New Year & major festivals',
    region: 'China / East Asia',
    emoji: '🐉',
    fixed: [
      { month: 10, day: 1,  name: 'National Day of the PRC' },
    ],
    getYear(y) {
      // Chinese New Year dates — hardcoded for 2020-2035 (accurate)
      const cny = {
        2020: [1,25], 2021: [2,12], 2022: [2,1],  2023: [1,22],
        2024: [2,10], 2025: [1,29], 2026: [2,17], 2027: [2,6],
        2028: [1,26], 2029: [2,13], 2030: [2,3],  2031: [1,23],
        2032: [2,11], 2033: [1,31], 2034: [2,19], 2035: [2,8],
      }
      const days = []
      if (cny[y]) {
        const [m, d] = cny[y]
        days.push({ month: m, day: d,   name: '🧧 Chinese New Year' })
        days.push({ month: m, day: d+1, name: 'Chinese New Year (Day 2)' })
        days.push({ month: m, day: d+2, name: 'Chinese New Year (Day 3)' })
      }
      // Mid-Autumn Festival — 15th day of 8th lunar month (approximate Gregorian)
      const maf = { 2024:[9,17], 2025:[10,6], 2026:[9,25], 2027:[9,15], 2028:[10,3], 2029:[9,22] }
      if (maf[y]) days.push({ month: maf[y][0], day: maf[y][1], name: '🥮 Mid-Autumn Festival' })
      // Qingming (Tomb Sweeping) — around April 5
      days.push({ month: 4, day: 5, name: '🌿 Qingming Festival' })
      // Dragon Boat Festival — 5th day of 5th lunar month (approximate)
      const dbf = { 2024:[6,10], 2025:[5,31], 2026:[6,19], 2027:[6,9], 2028:[5,28] }
      if (dbf[y]) days.push({ month: dbf[y][0], day: dbf[y][1], name: '🐉 Dragon Boat Festival' })
      return days
    },
  },

  // ── Ireland ───────────────────────────────────────────────────────────────────
  {
    id: 'ireland',
    label: 'Irish Public Holidays',
    region: 'Ireland',
    emoji: '🇮🇪',
    fixed: [
      { month: 1,  day: 1,  name: "New Year's Day" },
      { month: 2,  day: 1,  name: "St Brigid's Day" },
      { month: 3,  day: 17, name: "St Patrick's Day" },
      { month: 8,  day: 4,  name: 'August Bank Holiday' }, // first Monday Aug — approx
      { month: 10, day: 27, name: 'October Bank Holiday' }, // last Monday Oct — approx
      { month: 12, day: 25, name: 'Christmas Day' },
      { month: 12, day: 26, name: "St Stephen's Day" },
    ],
    getYear(y) {
      const days = []
      const easter = _easterSunday(y)
      const em = new Date(easter); em.setDate(em.getDate()+1)
      days.push({ month: em.getMonth()+1, day: em.getDate(), name: 'Easter Monday' })
      days.push(_nthWeekday(y, 5, 1, 1, 'May Bank Holiday'))
      days.push(_nthWeekday(y, 6, 1, 1, 'June Bank Holiday'))
      days.push(_nthWeekday(y, 8, 1, 1, 'August Bank Holiday'))
      days.push(_lastWeekday(y, 10, 1, 'October Bank Holiday'))
      return days
    },
  },

  // ── Australia ─────────────────────────────────────────────────────────────────
  {
    id: 'australia',
    label: 'Australian Public Holidays',
    region: 'Australia',
    emoji: '🇦🇺',
    fixed: [
      { month: 1,  day: 1,  name: "New Year's Day" },
      { month: 1,  day: 26, name: 'Australia Day' },
      { month: 4,  day: 25, name: 'ANZAC Day' },
      { month: 12, day: 25, name: 'Christmas Day' },
      { month: 12, day: 26, name: 'Boxing Day' },
    ],
    getYear(y) {
      const days = []
      const easter = _easterSunday(y)
      const gf = new Date(easter); gf.setDate(gf.getDate()-2)
      days.push({ month: gf.getMonth()+1, day: gf.getDate(), name: 'Good Friday' })
      const es = new Date(easter)
      days.push({ month: es.getMonth()+1, day: es.getDate(), name: 'Easter Saturday' })
      const em = new Date(easter); em.setDate(em.getDate()+1)
      days.push({ month: em.getMonth()+1, day: em.getDate(), name: 'Easter Monday' })
      days.push(_nthWeekday(y, 6, 1, 2, "Queen's/King's Birthday"))
      return days
    },
  },

  // ── Canada ────────────────────────────────────────────────────────────────────
  {
    id: 'canada',
    label: 'Canadian Statutory Holidays',
    region: 'Canada',
    emoji: '🇨🇦',
    fixed: [
      { month: 1,  day: 1,  name: "New Year's Day" },
      { month: 7,  day: 1,  name: 'Canada Day' },
      { month: 11, day: 11, name: 'Remembrance Day' },
      { month: 12, day: 25, name: 'Christmas Day' },
      { month: 12, day: 26, name: 'Boxing Day' },
    ],
    getYear(y) {
      const days = []
      const easter = _easterSunday(y)
      const gf = new Date(easter); gf.setDate(gf.getDate()-2)
      days.push({ month: gf.getMonth()+1, day: gf.getDate(), name: 'Good Friday' })
      days.push(_nthWeekday(y, 5, 1, 3, 'Victoria Day')) // 3rd Mon before May 25
      days.push(_nthWeekday(y, 8, 1, 1, 'Civic Holiday'))
      days.push(_nthWeekday(y, 9, 1, 1, 'Labour Day'))
      days.push(_nthWeekday(y, 10, 1, 2, 'Thanksgiving'))
      return days
    },
  },

  // ── India ─────────────────────────────────────────────────────────────────────
  {
    id: 'india',
    label: 'Indian National Holidays',
    region: 'India',
    emoji: '🇮🇳',
    fixed: [
      { month: 1,  day: 26, name: 'Republic Day' },
      { month: 8,  day: 15, name: 'Independence Day' },
      { month: 10, day: 2,  name: 'Gandhi Jayanti' },
      { month: 12, day: 25, name: 'Christmas Day' },
    ],
    getYear(y) {
      return [
        // Diwali — approximate (varies with lunar calendar)
        ...(({
          2024:[11,1], 2025:[10,20], 2026:[11,8], 2027:[10,29], 2028:[10,17]
        })[y] ? [{ month: ({2024:[11,1],2025:[10,20],2026:[11,8],2027:[10,29],2028:[10,17]})[y][0], day: ({2024:[11,1],2025:[10,20],2026:[11,8],2027:[10,29],2028:[10,17]})[y][1], name: '🪔 Diwali' }] : []),
        // Holi — approximate
        ...(({
          2024:[3,25], 2025:[3,14], 2026:[3,3], 2027:[3,22], 2028:[3,11]
        })[y] ? [{ month: ({2024:[3,25],2025:[3,14],2026:[3,3],2027:[3,22],2028:[3,11]})[y][0], day: ({2024:[3,25],2025:[3,14],2026:[3,3],2027:[3,22],2028:[3,11]})[y][1], name: '🎨 Holi' }] : []),
      ]
    },
  },
]

// ── Private helpers ────────────────────────────────────────────────────────────
function _easterSunday(y) {
  const a=y%19,b=Math.floor(y/100),c=y%100,d=Math.floor(b/4),e=b%4
  const f=Math.floor((b+8)/25),g=Math.floor((b-f+1)/3),h=(19*a+b-d-g+15)%30
  const i=Math.floor(c/4),k=c%4,l=(32+2*e+2*i-h-k)%7
  const m=Math.floor((a+11*h+22*l)/451)
  const month=Math.floor((h+l-7*m+114)/31), day=((h+l-7*m+114)%31)+1
  return new Date(y, month-1, day)
}

// nth occurrence of weekday (0=Sun..6=Sat) in a month (1-based)
function _nthWeekday(y, month, weekday, n, name) {
  const first = new Date(y, month-1, 1)
  const diff   = (weekday - first.getDay() + 7) % 7
  const day    = 1 + diff + (n-1)*7
  return { month, day, name }
}

// last occurrence of weekday in a month
function _lastWeekday(y, month, weekday, name) {
  const last = new Date(y, month, 0) // last day of month
  const diff  = (last.getDay() - weekday + 7) % 7
  return { month, day: last.getDate() - diff, name }
}

// ── Build holiday map for a given year ────────────────────────────────────────
// Returns { 'YYYY-MM-DD': [{name, setId, emoji}] }
function buildHolidayMap(year, enabledSetIds) {
  const map = {}
  for (const set of HOLIDAY_SETS) {
    if (!enabledSetIds.includes(set.id)) continue
    const all = [
      ...(set.fixed || []),
      ...(set.getYear ? set.getYear(year) : []),
    ]
    for (const h of all) {
      if (!h || !h.month || !h.day) continue
      const key = `${year}-${String(h.month).padStart(2,'0')}-${String(h.day).padStart(2,'0')}`
      if (!map[key]) map[key] = []
      map[key].push({ name: h.name, setId: set.id, emoji: set.emoji })
    }
  }
  return map
}
