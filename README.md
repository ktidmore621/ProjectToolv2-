# Customer Assignment Tool

A lightweight, configurable workflow application for tracking at-risk customer (MCP) recovery work performed by assigned colleagues (BAs/BEAs). Built to the **Customer Assignment Tool — Master Product & Technical Specification**.

## Quick start

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
- **§4 Workflow** — template-generated tasks (snapshot at creation → non-retroactive template edits by construction), ad-hoc tasks (standard tasks can't be removed/reordered), soft out-of-order warning, skip-requires-reason everywhere, conditional action-plan tasks behind the "Action plan needed?" decision point, auto-logged status-change activity, RAG auto-calc with audited manual override, closure requirements with audited override path.
- **§5 Configuration (open to all users)** — generic picklist manager (deactivate-not-delete guardrail, protected system values), template builder with live preview, field-requirement rules read at runtime (Creation / Always / At closure), RAG day-thresholds editable, per-view card/column layouts with locked fields and live preview.
- **§6 Kanban** — Portfolio board (columns = Project Status, RAG left-edge bar, days-in-status, next due task, filters, closure validation on drop) and per-project Task board (columns = Task Status, same skip/decision rules as the detail view).
- **§7 Timecards** — My Timecard weekly grid (project rows, expandable task sub-rows, click-cell quick add, week nav) and Team Timecard (user → project drill-down, hours-by-activity-type, weekly + custom-range CSV export). Approval workflow deferred per §7.3.
- **§8 Import/Export** — CSV project import with validation + preview before commit; CSV exports for projects, time entries, and the wins/closure report.
- **§9 Screens** — Dashboard, Portfolio Kanban, Project List, Project Detail (Tasks list/Kanban toggle, Time, Notes/Activity, History tabs), My/Team Timecard, History archive, Configuration.
- **§10 Design system** — token-driven theme (desaturated RAG palette, IBM Plex Sans/Mono), RAG as consistent visual language, skeleton loading, plain-language toasts, keyboard-visible focus, color always paired with labels, `prefers-reduced-motion` respected.

## Defaults chosen for the §11 open items

All editable in **Configuration** after the fact:

- RAG thresholds: Red = required task overdue **3+** days; Amber = due within **3** days or stalled **7** days (Configuration → Field Requirements).
- Default template due offsets: +5/+10/+14/+16/+18 days for analysis → decision, +21/+28 for conditional action-plan tasks, +30 for final review/close; High priority for analysis & visit, Medium otherwise.

## Layout

```
server/   Express API, SQLite schema (src/db.ts), business rules (src/core.ts), seed (src/seed.ts)
client/   React app — pages/ per screen, components/fields.tsx renders config-driven layouts
```
