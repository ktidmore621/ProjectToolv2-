# Accio

A lightweight, configurable workflow application for tracking at-risk customer (MCP) recovery work performed by assigned colleagues (BAs/BEAs). Built to the **Master Product & Technical Specification** (originally titled "Customer Assignment Tool").

## Easiest demo: the single-file version (no installs at all)

`demo/Accio (Demo).html` is the entire app packed into one HTML file. Download that one file, double-click it, and it opens in your browser — no Node.js, no server, no IT approvals. The "server" runs inside the browser: all screens and business rules behave identically, sample data included, and your changes are remembered by that browser (a **Reset data** link in the sidebar restores the samples). To rebuild it after code changes: `npm run build:demo`.

Ideal for demos and requirements walkthroughs. The server version below is the one to deploy when the team starts using it for real, since the demo file's data lives only in each person's own browser.

## Not a developer? Start here

1. **Install Node.js** (free, one time): go to https://nodejs.org and install the green **LTS** version, clicking Next through the installer.
2. **Get this project onto your computer**: on the GitHub page, click the green **Code** button → **Download ZIP**, then unzip it anywhere (e.g. your Desktop).
3. **Double-click the launcher** in the unzipped folder:
   - Windows: `Start Tool (Windows).bat`
   - Mac: `Start Tool (Mac).command` (first time: right-click it → **Open** → **Open** to get past the security prompt)

A black window opens and does the setup (a minute or two the first time), then your browser opens the tool at `http://localhost:3001`. Pick a name under **"Working as"** in the sidebar and explore — it comes pre-loaded with sample projects. To stop the tool, close the black window.

## Quick start (developers)

```bash
npm install          # installs server + client workspaces
npm run seed         # creates SQLite db with default config + demo data
npm run dev          # API on :3001, web app on :5173
```

Open http://localhost:5173, pick your name in the sidebar ("Working as"), and everything is live.

**Production-style run** (single port, no Vite):

```bash
npm run build        # builds the client into client/dist
npm start            # Express serves API + built client on :3001
```

**Reset demo data:** `npm run seed -- --reset`

## Stack

| Layer | Choice | Note |
|---|---|---|
| Frontend | React + TypeScript + Vite, Tailwind (design tokens per §10), dnd-kit Kanban | |
| Backend | Node + Express + Zod | Business rules enforced server-side |
| Database | **SQLite** (better-sqlite3) | Spec §12.3 recommends PostgreSQL; SQLite chosen for zero-setup MVP. The schema is fully relational and ports to Postgres without redesign. |
| Auth | Pick-your-name user switcher | Matches §5's no-role-gate MVP decision; the `users` table leaves room for real auth/`is_admin` later without schema change. |

## What's implemented (spec map)

- **§2 Lifecycle** — auto Project IDs (`CAP-0001`…), one active project per MCP (server-enforced), closed projects permanently read-only, returning MCPs get a new project.
- **§4 Workflow** — template-generated tasks (snapshot at creation → non-retroactive template edits by construction), ad-hoc tasks (standard tasks can't be removed/reordered), soft out-of-order warning, skip-requires-reason everywhere, auto-logged status-change activity, RAG auto-calc with audited manual override, closure requirements with audited override path.
- **§5 Configuration (open to all users)** — generic picklist manager (deactivate-not-delete guardrail, protected system values), template builder with live preview, field-requirement rules read at runtime (Creation / Always / At closure), RAG day-thresholds editable, per-view card/column layouts with locked fields and live preview.
- **§6 Kanban** — Portfolio board (columns = Project Status, RAG left-edge bar, days-in-status, next due task, filters, closure validation on drop) and per-project Task board (columns = Task Status, same skip rules as the detail view).
- **§7 Timecards** — My Timecard weekly grid (project rows, expandable task sub-rows, click-cell quick add, week nav) and Team Timecard (user → project drill-down, hours-by-activity-type, weekly + custom-range CSV export). Approval workflow deferred per §7.3.
- **§8 Import/Export** — CSV project import with validation + preview before commit; CSV exports for projects, time entries, and the wins/closure report.
- **§9 Screens** — Home, Portfolio Kanban, Project List, Project Detail (Tasks list/Kanban toggle, Time, Notes/Activity, History tabs), My/Team Timecard, History archive, Configuration.
- **§10 Design system** — token-driven theme (desaturated RAG palette, IBM Plex Sans/Mono), RAG as consistent visual language, skeleton loading, plain-language toasts, keyboard-visible focus, color always paired with labels, `prefers-reduced-motion` respected.

## v2 enhancements (per the v2 delta spec)

- **§1 Navigation** — the standalone Kanban nav item merged into **Projects**: one screen with a List / Kanban / Task List view toggle ahead of the search field; clicking Projects in the nav always opens the default Project List. The new cross-project **Task List View** filters (Overdue, Blocked, Assigned To, Project, Status) combine and live in the URL, so every Home KPI deep-links into a pre-filtered view.
- **§2 Home redesign** — time-of-day greeting, KPI cards with icon badges + trend lines, Portfolio RAG bar, "This Week" agenda (tasks due + calls/visits/meetings, grouped Today/Tomorrow/weekday, completed items checked & muted), Recent Activity feed (rows show the customer/MCP name), and a Recent Wins highlight reel.
- **§3 Wins** — first-class `wins` entity: loggable at any point in a project's lifecycle (Wins tab on Project Detail), timestamped (occurred vs logged), categorized via the admin-configurable **Win Category** picklist, and exportable portfolio-wide with a date range (`/api/export/wins.csv`). The v1 closed-projects report lives on at `/api/export/closures.csv`; `final_summary` stays as the closure narrative.
- **§4 Task notes** — append-only note history per task (backed by the existing Activity entity, indexed by task + date); latest note surfaces inline in the task list and task modal, notes can be added while creating or editing a task.
- **§5 Activity logging** — Notes & Activity workspace: log Phone Calls / Site Visits / Client Meetings / Other with date + start/end times, linked **many-to-many** to tasks via the new `task_activity_links` join table; module filters for Notes / Activities / All.
- **§6 Activity visibility** — clickable Activity-count column on both task lists opens a side drawer (type, date, derived duration, user, notes) with a jump to the full record.
- **§7 Collapsed nav** — the user selector collapses to a circular initials avatar with a popover switcher (option A).

## v3 enhancements & fixes (per the "Enhancements & Bug Fixes" batch)

- **Archive, never delete** — a picklist value that has ever been used is *archived* on deletion:
  hidden from dropdowns for new entries, rendered unchanged on every legacy record, findable via the
  Archived filters (Configuration → Picklists & Values, plus record filters). Never-used values can
  still be hard-deleted. The reference check covers custom-field values (project *and* task).
- **Skipped retired (E4)** — the Skipped task status is archived; legacy Skipped tasks still render and
  still satisfy closure, but new tasks are either completed or **deleted** (trash icon, with confirmation).
  Deleting a task re-parents its time logs and notes/activities to the project — timecards lose nothing.
- **Cancellation = closure (E5)** — cancelling runs the full closure workflow (audit, read-only,
  cleared RAG overrides); it requires a Close Reason, Final Summary optional.
- **Central Time (E6)** — all due/overdue/RAG date logic runs on `America/Chicago` (DST-aware).
- **Project Name (E3)** — optional free-text field shown right after MCP Name everywhere.
- **Task custom fields (E9)** — the custom-field engine supports `object_type: task`; task fields appear
  on task forms, the task modal, and the task list/card layouts (cross-project Task List honors layout config).
- **In-task time logging & status (E1/E2)** — both live in the Task modal, backed by the same stores.
- **Wins (B4/E8)** — author-only edit/delete, audit-logged, no orphaned system notes.
- **Reporting (E10/E11)** — RAG summaries show count + total AP; big lists paginate server-side (25/page).
- **Robustness** — project codes come from a sequence (B3), CSV exports are formula-injection safe (B5),
  API errors are structured JSON with server-side-only stack traces (B7).
- **Tests** — `npm test` runs the vitest + supertest suite in `server/test/`
  (`ACCIO_DB_PATH` points the server at a throwaway database).

## Defaults chosen for the §11 open items

All editable in **Configuration** after the fact:

- RAG thresholds: Red = required task overdue **3+** days; Amber = due within **3** days or stalled **7** days (Configuration → Field Requirements).
- Default template due offsets: +5/+10/+14/+16 days for the analysis steps, +21/+28 for the action-plan tasks, +30 for final review/close; High priority for analysis & visit, Medium otherwise.

## Security model (read this before deploying beyond a trusted team)

- **There is no authentication.** "Working as" is a convenience switcher, not sign-in.
- **`Show Configuration` is UI visibility only, not access control.** Turning it off hides the
  Configuration nav item and redirects the page, but **every `/api/*` configuration endpoint remains
  reachable** by anyone who can reach the server. The same applies to author-only rules (notes, wins):
  they are enforced against a self-declared user id. Real authorization requires adding
  authentication and server-side permission checks to the routes in `server/src/routes/config.ts`
  (and friends) — the `users` table leaves room for an `is_admin` flag without schema redesign.

## Layout

```
server/   Express API, SQLite schema (src/db.ts), business rules (src/core.ts), seed (src/seed.ts)
client/   React app — pages/ per screen, components/fields.tsx renders config-driven layouts
```
