# Changelog

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
