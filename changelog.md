# Changelog

## 2.2.2

- Corrected the production build version displayed by the application to `2.2.2`.

### Latest settings fixes

- Removed the duplicate standalone **Task Lists** settings tab and kept Task Lists under Features.
- Added independent loading and inline error states for settings panels, so one unavailable endpoint cannot blank the page.
- Added immediate loading states for Security and Backup while their data is fetched.
- Ensured `assign_own_tasks` remains selectable when an older server permission catalogue is in use.
- Replaced the browser-native role deletion prompt with the themed in-app confirmation dialog.
- Fixed role saves dropping `assign_own_tasks` by adding it to the server’s authoritative permission catalogue.
- Replaced the browser-native Clear App Cache prompt with the consistent themed settings dialog.

## 2026-09-03

- Added dedicated permissions for the Task Lists and API Reference settings pages, keeping page visibility separate from edit permissions.
- API Reference catalogue access now follows the same `view_api_reference` permission as its settings page.
- Task list reads now honour the dedicated `view_task_lists` permission without granting task-list creation or editing.
- Separated the personal **My Team** view from the administrative **People & Teams** settings page.
- Added a dedicated `view_people_teams` permission for organisation-wide People & Teams administration.
- Kept `view_teams` as the native-compatible team visibility permission, so existing iOS and Android clients continue to show their Team page without an app update.
- Improved role permission descriptions and clarified which permission unlocks each team surface.
- Reduced repeated permission database lookups during authenticated requests, improving calendar and settings response time.

- Improved logout reliability and made repeated logout taps safe; logout and routine authenticated reads no longer consume sign-in rate-limit attempts.
- Added a per-user session cap to automatically remove the oldest abandoned device sessions.
- Strengthened iCal feed privacy headers and bounded abandoned device sessions without changing native authentication contracts.
- Redacted bearer tokens from iCal feed request logs to prevent accidental disclosure through server log files.
- Removed an unused server cache middleware that was never attached to a route.

- Added a dedicated **Tasks** permission group, including separate access to view tasks, assign task lists to yourself, and manage task lists.
- Added dedicated task-list permissions; task assignment no longer implies permission to create or edit task lists.
- Settings navigation and supporting data loads now follow the account’s assigned permissions instead of relying on role names.
- Shift Leads can now view organisations and locations needed for day-to-day rota management.
- Improved task assignment API and calendar controls for users who may assign their own task lists only.
- Prevented mobile Safari focus zoom in authentication and editor forms, keeping date pickers and bottom-sheet menus within the viewport.
- Extended the modern sign-in, sign-up and password-recovery presentation to mobile with a compact branded header, while preserving light, dark and OLED theme assets.
- Restored the opt-in “Remember me” behaviour for users who explicitly want local password storage, with a clear private-device warning.
- Added baseline security response headers and ensured administrator and recovery password resets revoke existing sessions.
- Password changes from the profile page now revoke other active sessions while preserving the newly authenticated session.
- Production authentication cookies now enforce the Secure flag automatically when served over HTTPS.
- Passkey sign-ins are now tracked as revocable sessions, matching password sign-ins.
- Login responses no longer reveal whether an inactive email address exists, and passkey endpoints now have dedicated rate limiting.
- Expired session records are now removed automatically and when the Active Sessions panel is opened, so stale devices no longer accumulate indefinitely.

## 2026-08-24

- Added an **Absent / Sick** day status alongside Annual Leave.
- Absent days appear as all-day **“Absent”** events in iCal feeds.
- Added database migration and backup support for absence types.
- Kept existing day-off records as Annual Leave.
- Improved organisation and team assignment dialogs with clearer guidance and searchable people lists.
- Added absence status to the existing shift API for native clients.
- Fixed users appearing multiple times in People & Teams when one account belongs to multiple teams or organisations.
- Clarified the difference between My Team (personal view) and People & Teams (administration); administrators now manage teams from People & Teams only.

## 2026-08-13

- Added descriptions for every role permission and separated legacy compatibility permissions into a clearly labelled Legacy section.
- Restored built-in role descriptions when older or partially migrated role APIs return empty descriptions.
- Restored the staging release candidate metadata to 2.1.3-rc.
- Hardened task-list and template-group reads so view-only roles require the matching section permission and only receive groups assigned to them.
- Added scoped role permissions for team rotas, all rotas, team shifts, all shifts, team tasks, all tasks, and team administration.
- Updated the iOS built-in-role fallback catalogue so older servers and offline role data understand the new scopes.
- Updated Android shift capability checks to honour server permissions for custom roles while retaining legacy-role compatibility.
- Added a Roles & permissions health warning for active accounts with missing or unknown role assignments.
- Applied team-scoped rota visibility and shift editing to the new scoped permissions instead of relying only on the Shift Lead role name.
- Assigned the new scopes to the protected Shift Lead and Manager defaults and kept native fallback role data aligned.
- Updated web navigation and section access payloads to recognise the new scoped rota and task permissions.
- Added a lightweight permission regression check covering the catalogue, built-in roles and scoped route enforcement.
- Added scope descriptions to role comparison so administrators can distinguish team-level and global access.
- Removed duplicated task-route permission middleware in favour of one shared capability check.
- Applied the new assigned-team and all-team permissions to team management endpoints while preserving the legacy `manage_teams` permission.
- Added the native Team screen’s member fallback endpoint (`GET /api/teams/:id/members`) with the same role and organisation visibility rules as the main teams feed.
- Fixed Manager organisation views so assigned members are shown directly instead of appearing undefined.
- Added a shared My Team view for any role with team-view permission, while keeping team editing controls restricted to team managers.
- Renamed the administrative Team page to People & Teams to distinguish it from personal team views.
- Added role comparison for administrators and expanded audit labels for roles, organisations and location membership changes.
- Added broader permission coverage for workspace sections and preserved the existing native API contract.

## 2026-08-12

- Added section-level view permissions for Calendar, Shifts, Tasks, Templates, Teams, Locations, Organisations and Settings.
- Added organisation-scoped team and user visibility for custom roles, with permissions shared through the existing web and mobile API payloads.
- Added permission-aware navigation so users only see the workspace sections available to them.
- Added `sectionAccess` to the configuration response so native clients can adapt navigation without a new API route or breaking contract.
- Kept existing role permissions and mobile endpoints backward-compatible while enforcing view access for shifts, tasks, templates, locations and organisations.

## 2026-08-04

- Added custom roles with selectable colours and granular permissions. Built-in roles remain protected.
- Added multi-organisation locations and automatic handling of inactive accounts.
- Added a View organisation team members permission for custom roles, with web and mobile team visibility limited to the organisations the user belongs to and without exposing private account details.
- Added role-aware permissions across the web app and native mobile API, including safer rota, user, shift and export access.
- Added an administrator API Reference with the v2 endpoint catalogue; all existing mobile routes remain compatible.
- Modernised the calendar toolbar, profile page, Settings pages, templates, dialogs and responsive navigation.
- Improved theme-aware branding and readability across Light, Dark, OLED and mobile layouts.
- Fixed narrow-screen calendar overlap, search/filter layout, template filters, role fallbacks and repeated error notifications.
- Fixed startup migrations for older databases, including roles, task assignments, holiday preferences and SQLite empty-string handling.
- Hardened Proxmox updates and removed the obsolete npm `--unsafe-perm` option.

## 2026-08-01

- Fixed mobile shift details hiding the navigation and added spacing between task lists.
- Made mobile Search & Filters collapsible while keeping desktop search unchanged.

## 2026-07-30

- Fixed mobile calendar scrolling and clipping while keeping the desktop Month view fitted and non-scrolling.

## 2026-07-29

- Modernised calendars, shift/task editors, templates, Settings dialogs, authentication screens and popup menus.
- Added responsive calendar views, Agenda, improved accessibility, keyboard navigation and reduced-motion support.
- Added theme-safe logos, status colours and form surfaces across the application.
- Added the administrator API Reference and mobile API contract checks.
- Improved calendar filtering, CSV exports, shift validation, task visibility and organisation editing.
- Removed unused dependencies, obsolete scripts and stale tracked metadata.
