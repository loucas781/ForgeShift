# Changelog

## 2026-07-29

- Modernised the complete authentication journey with a responsive split-screen presentation, clearer form hierarchy, larger controls, improved recovery states, and a focused mobile layout for sign-in, sign-up, forgot-password, and reset-password screens.
- Audited Light, Dark, and OLED styling across the web app; defined missing shared colour aliases, added accessible theme-specific brand and status colours, and corrected unreadable success, warning, active-control, and destructive-action treatments.
- Added an administrator-only API Reference in Settings with a live catalogue of every available endpoint, method and access level, plus search, method filters, mobile-route filtering, and copyable URLs.
- Added a mobile API contract guard covering 36 native-client routes; the admin catalogue is additive and existing endpoint methods, paths, handlers, and response shapes remain unchanged.
- Reworked Settings into grouped Personal, Workspace, and System navigation with a responsive sidebar, cleaner admin page headers, calmer record rows, more consistent action placement, refined data tables, and roomier editing dialogs.
- Polished the calendar toolbar with a compact filter shelf, a dedicated search treatment, and a `/` shortcut that focuses calendar search without letting the field dominate the full toolbar width.
- Added clearly scoped `NEW` markers in Settings for the recently introduced Agenda preference, including a Preferences navigation cue and the Agenda choice itself.
- Enlarged the shift and task assignment editors on desktop, introduced a two-column shift layout where space allows, and improved the task dialog with accessible day controls, focus trapping, and focus restoration.
- Refreshed the calendar UI with responsive scope, location, type, search, and date controls; a seven-day Agenda view; clearer daily and period coverage summaries; improved shift overflow details; and a more structured shift editor with live duration, previous-day copying, and remembered session defaults.
- Added Agenda as a saved default calendar view and improved calendar accessibility with complete tab semantics, keyboard navigation, focus restoration, larger mobile controls, visible focus states, and reduced-motion support.
- Made CSV downloads match the currently displayed calendar filters and corrected keyboard activation, empty-state transitions, editor focus handoff, and overnight daily coverage in the refreshed views.
- Hardened calendar data loading and rendering: parallel, latest-request-wins loading with recoverable errors; escaped calendar, shell, and iCal preview values; correct adjacent-year holidays; and non-stacking drag listeners.
- Reduced SSE event payloads to event metadata and fixed the `/calendar.html` alias.
- Added shift date/time validation, overnight CSV duration handling, and clear duplicate-date conflicts on update.
- Restricted member shift/task reads and user directory reads to authorised scopes.
- Removed the obsolete version bump script, unused `ical-generator` dependency and stale tech-stack label, plus dead tracked backup/metadata artifacts.
