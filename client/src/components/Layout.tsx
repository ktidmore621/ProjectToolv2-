import { useEffect, useRef, useState } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { IS_DEMO } from "../api";
import { useSession } from "../state";

const NAV = [
  { to: "/", label: "Dashboard", icon: "▦", end: true },
  { to: "/projects", label: "Projects", icon: "▤" },
  { to: "/timecard", label: "My Timecard", icon: "◷" },
  { to: "/team-timecard", label: "Team Timecard", icon: "◫" },
  { to: "/history", label: "History", icon: "◔" },
  { to: "/config", label: "Configuration", icon: "⚙" },
];

export function Layout() {
  const [collapsed, setCollapsed] = useState(false);
  const { users, currentUser, setCurrentUser } = useSession();

  return (
    <div className="flex min-h-screen">
      <nav
        className={`sticky top-0 flex h-screen shrink-0 flex-col border-r border-hairline bg-surface transition-[width] duration-200 ${collapsed ? "w-14" : "w-56"}`}
        aria-label="Primary"
      >
        <div className="flex items-center gap-2.5 px-4 py-4">
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-primary font-mono text-sm font-semibold text-white">CA</span>
          {!collapsed && (
            <div className="leading-tight">
              <div className="text-sm font-semibold tracking-tight">Customer Assignment</div>
              <div className="text-[11px] text-muted">Workflow tool</div>
            </div>
          )}
        </div>
        <div className="flex-1 space-y-0.5 px-2 py-2">
          {NAV.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.end}
              title={collapsed ? n.label : undefined}
              className={({ isActive }) =>
                `flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-medium transition-colors ${
                  isActive ? "bg-primary-soft text-primary" : "text-muted hover:bg-canvas hover:text-ink"
                }`
              }
            >
              <span className="w-5 text-center" aria-hidden>{n.icon}</span>
              {!collapsed && n.label}
            </NavLink>
          ))}
        </div>
        {IS_DEMO && !collapsed && (
          <div className="mx-2 mb-2 rounded-lg bg-accent-soft px-3 py-2 text-[11px] leading-snug text-ink">
            <b>Demo mode</b> — sample data lives only in this browser.{" "}
            <button
              className="font-medium text-accent underline"
              onClick={async () => {
                const { resetDemoData } = await import("../demo/backend");
                resetDemoData();
                window.location.reload();
              }}
            >
              Reset data
            </button>
          </div>
        )}
        <div className="border-t border-hairline p-2">
          {collapsed ? (
            <CollapsedUserSwitcher />
          ) : (
            <>
              <label className="mb-1.5 block px-1 text-[11px] font-medium text-muted">Working as</label>
              <select
                aria-label="Current user"
                className="w-full rounded-lg border border-hairline bg-surface px-2 py-1.5 text-xs focus:border-accent focus:outline-none"
                value={currentUser?.id ?? ""}
                onChange={(e) => {
                  const u = users.find((x) => x.id === Number(e.target.value));
                  if (u) setCurrentUser(u);
                }}
              >
                <option value="" disabled>Select user…</option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>{u.name}</option>
                ))}
              </select>
            </>
          )}
          <button
            onClick={() => setCollapsed(!collapsed)}
            className={`mt-2 rounded-lg py-1.5 text-xs text-muted hover:bg-canvas hover:text-ink ${collapsed ? "w-10 text-center" : "w-full px-2"}`}
            aria-label={collapsed ? "Expand navigation" : "Collapse navigation"}
          >
            {collapsed ? "»" : "« Collapse"}
          </button>
        </div>
      </nav>
      <main className="min-w-0 flex-1">
        <Outlet />
      </main>
    </div>
  );
}

export function initialsOf(name: string): string {
  return name.split(" ").map((s) => s[0]).join("").slice(0, 2).toUpperCase();
}

/**
 * Collapsed-nav user control (v2 §7, option A): the full selector is replaced
 * by a circular initials avatar — same visual language as the customer badges
 * in the dashboard's This Week panel. Clicking it opens a popover with account
 * actions (switch user), so everything stays one click away.
 */
function CollapsedUserSwitcher() {
  const { users, currentUser, setCurrentUser } = useSession();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(!open)}
        title={currentUser ? `Working as ${currentUser.name}` : "Select user"}
        aria-label={currentUser ? `Working as ${currentUser.name} — switch user` : "Select user"}
        aria-expanded={open}
        className="grid h-10 w-10 place-items-center rounded-full border border-hairline bg-primary-soft font-mono text-xs font-semibold text-primary transition-colors hover:border-accent"
      >
        {currentUser ? initialsOf(currentUser.name) : "?"}
      </button>
      {open && (
        <div className="absolute bottom-0 left-full z-30 ml-3 w-52 rounded-xl border border-hairline bg-surface p-1.5 shadow-lift">
          <div className="px-2 pb-1.5 pt-1 text-[11px] font-medium text-muted">Working as</div>
          {users.map((u) => (
            <button
              key={u.id}
              onClick={() => { setCurrentUser(u); setOpen(false); }}
              className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition-colors ${
                u.id === currentUser?.id ? "bg-primary-soft font-medium text-primary" : "hover:bg-canvas"
              }`}
            >
              <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-canvas font-mono text-[10px] font-semibold text-muted">
                {initialsOf(u.name)}
              </span>
              {u.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Standard page shell: title row + content, tighter than the Dashboard (§10.4). */
export function Page({ title, actions, children, breathe }: {
  title: React.ReactNode; actions?: React.ReactNode; children: React.ReactNode; breathe?: boolean;
}) {
  return (
    <div className={`mx-auto max-w-[1400px] ${breathe ? "px-8 py-7" : "px-6 py-5"}`}>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {children}
    </div>
  );
}
