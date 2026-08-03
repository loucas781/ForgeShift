# Changelog

## 2026-08-04

- Fixed the collapsed Search & Filters control being auto-placed into the mobile navigation grid on extra-small screens, restoring the intended title, calendar navigation, date, filter and summary rows.

## 2026-08-01

- Fixed the mobile shift-details flow moving the outer Safari viewport and hiding the ForgeShift navigation by preserving calendar scroll position and using no-scroll focus restoration.
- Added consistent spacing between task-list cards in the shift and day detail panel across desktop and mobile.
- Replaced the always-expanded mobile search and filter shelf with a compact accessible disclosure that defaults closed, shows the active-filter count, expands for the `/` shortcut, and leaves the desktop search workflow unchanged.

## 2026-07-30

- Fixed the mobile calendar being cut off and unable to scroll by giving the page one touch-friendly vertical scroller, allowing readable Month rows to extend naturally, and retaining the fitted non-scrolling calendar layout on desktop.

## 2026-07-29

- Modernised every custom Settings dialog with contextual headers, clearer hierarchy, theme-safe form surfaces, responsive actions and accessible dialog labelling; refined Location and Task List editors into responsive field grids and brought the legacy password-reset popup into the shared dialog system.
- Fixed Organisation Edit and Delete actions failing when their inline button markup embedded an organisation name, and made both actions resolve the current organisation safely by ID.
- Modernised popup menus across Calendar, Templates, Settings, and Profile with a consistent theme-safe backdrop, elevated dialog shell, clearer headers, roomier controls, and pinned responsive actions; rebuilt the template editor as grouped details and responsive day cards so it no longer relies on a sprawling horizontal scroller.
- Restored the complete non-scrolling Month view while keeping busy dates contained through viewport-fitted week rows, compact mobile indicators, and day-panel overflow actions.
- Fixed modern Month view rows collapsing around task, coverage, and shift content, which allowed shift chips to render underneath the following calendar row.
- Modernised Month, Week, and Agenda calendars across desktop and mobile with a calmer responsive toolbar, card-based month days, clearer current-day and weekend treatments, roomier shift chips, a refined week timeline, streamlined mobile overflow, polished agenda rows, and theme-safe loading/detail surfaces.
- Centred repeat-day button labels throughout the shift editor so weekday controls remain visually balanced at every responsive width.
- Modernised shift creation, shift editing, and task assignment with contextual headers, card-based sections, clearer scheduling controls, refined status choices, cleaner day pickers, responsive action bars, and more useful date/week context.
- Centralised theme-aware ForgeShift artwork so topbar, Settings About, authentication pages, every favicon variant, Apple touch icons, browser theme colour, and PWA manifests all stay in sync across Light, Dark, OLED, System, OS-driven, and cross-tab theme changes.
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
