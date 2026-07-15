import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { api, Picklist, User } from "./api";

// ---------- Current user (MVP: pick-your-name sign-in, no role gate per §5) ----------

interface Session {
  users: User[];
  currentUser: User | null;
  setCurrentUser: (u: User) => void;
  refreshUsers: () => Promise<void>;
}
const SessionCtx = createContext<Session>(null!);
export const useSession = () => useContext(SessionCtx);

/**
 * The assignee quick-filter value a view should open with, from the user's
 * Working As settings: their explicit Default Assignee Filter if set
 * ('all' = everyone → no filter), otherwise derived from their Dashboard
 * Default (My Items Only → themselves, Show All → no filter).
 */
export function defaultAssigneeOf(u: User | null): string {
  if (!u) return "";
  if (u.default_assignee_filter === "all") return "";
  if (u.default_assignee_filter) return u.default_assignee_filter;
  return (u.dashboard_scope ?? "mine") === "mine" ? String(u.id) : "";
}

/**
 * Assignee quick-filter state for the Projects views: starts at the current
 * user's default and re-applies it when the working-as user changes; manual
 * overrides stick until then.
 */
export function useDefaultAssignee(): [string, (v: string) => void] {
  const { currentUser } = useSession();
  const [assignee, setAssignee] = useState(() => defaultAssigneeOf(currentUser));
  const uid = currentUser?.id;
  const applied = useRef(uid);
  useEffect(() => {
    if (applied.current === uid) return;
    applied.current = uid;
    setAssignee(defaultAssigneeOf(currentUser));
  }, [uid]); // eslint-disable-line react-hooks/exhaustive-deps
  return [assignee, setAssignee];
}

// ---------- Toasts (§10.5: plain-language confirmations) ----------

export interface Toast {
  id: number;
  text: string;
  tone: "info" | "success" | "warning" | "error";
}
interface ToastCtxType {
  toasts: Toast[];
  toast: (text: string, tone?: Toast["tone"]) => void;
}
const ToastCtx = createContext<ToastCtxType>(null!);
export const useToast = () => useContext(ToastCtx).toast;

// ---------- Picklists cache ----------

interface Config {
  picklists: Picklist[];
  list: (name: string) => Picklist | undefined;
  /** Values offered for NEW entries: active and not archived (B1). */
  activeValues: (name: string) => Picklist["values"];
  /** Archived values (B1) — still valid on legacy records, offered in filters so history stays findable. */
  archivedValues: (name: string) => Picklist["values"];
  refreshPicklists: () => Promise<void>;
}
const ConfigCtx = createContext<Config>(null!);
export const useConfig = () => useContext(ConfigCtx);

export function AppProviders({ children }: { children: React.ReactNode }) {
  const [users, setUsers] = useState<User[]>([]);
  const [currentUser, setCurrentUserState] = useState<User | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [picklists, setPicklists] = useState<Picklist[]>([]);
  const nextId = useRef(1);

  const refreshUsers = useCallback(async () => {
    const u = await api.get<User[]>("/api/users");
    setUsers(u);
    const savedId = Number(localStorage.getItem("cat_user_id"));
    setCurrentUserState((cur) => cur ?? u.find((x) => x.id === savedId) ?? null);
  }, []);

  const refreshPicklists = useCallback(async () => {
    setPicklists(await api.get<Picklist[]>("/api/picklists"));
  }, []);

  useEffect(() => {
    refreshUsers();
    refreshPicklists();
  }, [refreshUsers, refreshPicklists]);

  const setCurrentUser = (u: User) => {
    localStorage.setItem("cat_user_id", String(u.id));
    setCurrentUserState(u);
  };

  const toast = useCallback((text: string, tone: Toast["tone"] = "info") => {
    const id = nextId.current++;
    setToasts((t) => [...t, { id, text, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 5000);
  }, []);

  const list = (name: string) => picklists.find((p) => p.name === name);
  const activeValues = (name: string) => (list(name)?.values ?? []).filter((v) => v.is_active && !v.archived);
  const archivedValues = (name: string) => (list(name)?.values ?? []).filter((v) => v.archived);

  return (
    <SessionCtx.Provider value={{ users, currentUser, setCurrentUser, refreshUsers }}>
      <ConfigCtx.Provider value={{ picklists, list, activeValues, archivedValues, refreshPicklists }}>
        <ToastCtx.Provider value={{ toasts, toast }}>
          {children}
          <ToastViewport toasts={toasts} />
        </ToastCtx.Provider>
      </ConfigCtx.Provider>
    </SessionCtx.Provider>
  );
}

function ToastViewport({ toasts }: { toasts: Toast[] }) {
  const tones: Record<Toast["tone"], string> = {
    info: "border-hairline bg-surface text-ink",
    success: "border-rag-green/40 bg-surface text-ink",
    warning: "border-rag-amber/60 bg-surface text-ink",
    error: "border-rag-red/50 bg-surface text-ink",
  };
  const dots: Record<Toast["tone"], string> = {
    info: "bg-accent",
    success: "bg-rag-green",
    warning: "bg-rag-amber",
    error: "bg-rag-red",
  };
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-96 max-w-[90vw] flex-col gap-2" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast-enter pointer-events-auto flex items-start gap-2.5 rounded-lg border px-3.5 py-2.5 shadow-lift ${tones[t.tone]}`}>
          <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${dots[t.tone]}`} aria-hidden />
          <span className="text-sm leading-snug">{t.text}</span>
        </div>
      ))}
    </div>
  );
}
