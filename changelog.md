# Changelog

## 2026-08-24

- Added an Absent / Sick day status alongside Annual Leave. Absent days appear as all-day “Absent” events in iCal feeds and are included in the existing shift API for native clients.
- Added a migration and backup support for the new absence type while keeping existing day-off records as Annual Leave.
- Improved organisation and team assignment dialogs with clearer scope guidance and searchable people lists.

## 2026-08-13

- Fixed custom rota, shift, task and team permissions across web and native API clients.
- Fixed team-scoped and all-user rota permissions so the correct active users are returned to calendar selectors.
- Added compatible nested task feature flags for native clients while preserving the existing API fields.
- Removed inactive accounts from team member responses.
- Aligned the development release metadata back to the 2.1.3 development line.
- Added descriptions for every role permission and separated legacy compatibility permissions into a clearly labelled Legacy section.
- Restored the development release metadata to the 2.1.3 line to match staging.
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
- Changed Manager defaults from global rota access to organisation/team-scoped rota viewing and editing; only Admin retains global rota permissions.
- Made global rota visibility require the explicit `view_all_rotas` permission (or Admin), so legacy `view_other_rotas` cannot bypass organisation boundaries.
- Separated Manager and Shift Lead rota permissions: Managers use organisation-level shift management, while Shift Leads use team-level shift management.
- Added clear administrator-facing descriptions for Member, Shift Lead, Manager, Admin and Inactive roles.
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
