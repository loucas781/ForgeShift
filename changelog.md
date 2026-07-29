# Changelog

## 2026-07-29

- Refreshed the calendar UI with responsive scope, location, type, search, and date controls; a seven-day Agenda view; clearer daily and period coverage summaries; improved shift overflow details; and a more structured shift editor with live duration, previous-day copying, and remembered session defaults.
- Added Agenda as a saved default calendar view and improved calendar accessibility with complete tab semantics, keyboard navigation, focus restoration, larger mobile controls, visible focus states, and reduced-motion support.
- Made CSV downloads match the currently displayed calendar filters and corrected keyboard activation, empty-state transitions, editor focus handoff, and overnight daily coverage in the refreshed views.
- Hardened calendar data loading and rendering: parallel, latest-request-wins loading with recoverable errors; escaped calendar, shell, and iCal preview values; correct adjacent-year holidays; and non-stacking drag listeners.
- Reduced SSE event payloads to event metadata and fixed the `/calendar.html` alias.
- Added shift date/time validation, overnight CSV duration handling, and clear duplicate-date conflicts on update.
- Restricted member shift/task reads and user directory reads to authorised scopes.
- Removed the obsolete version bump script, unused `ical-generator` dependency and stale tech-stack label, plus dead tracked backup/metadata artifacts.
