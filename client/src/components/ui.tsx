import { ReactNode, useEffect, useRef } from "react";
import { csvDownload, Rag } from "../api";

/** Hex → rgba for tinted chip backgrounds. */
export function tint(hex: string, alpha: number): string {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
/** Darken a hex color so tinted-background chip text passes AA. */
export function deepen(hex: string): string {
  const h = hex.replace("#", "");
  const f = (s: string) => Math.round(parseInt(s, 16) * 0.62);
  return `rgb(${f(h.slice(0, 2))}, ${f(h.slice(2, 4))}, ${f(h.slice(4, 6))})`;
}

/** Colored status chip — color always paired with a text label (§10.6). */
export function Chip({ label, color, small }: { label: string; color: string; small?: boolean }) {
  return (
    <span
      className={`chip inline-flex items-center gap-1.5 rounded-full font-medium ${small ? "px-2 py-px text-[11px]" : "px-2.5 py-0.5 text-xs"}`}
      style={{ backgroundColor: tint(color, 0.14), color: deepen(color) }}
    >
      <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: color }} aria-hidden />
      {label}
    </span>
  );
}

const RAG_COLORS: Record<Rag, string> = { red: "#C2554E", amber: "#C99239", green: "#4E9468" };
const RAG_LABELS: Record<Rag, string> = { red: "Red", amber: "Amber", green: "Green" };

export function RagChip({ rag, reason, small }: { rag: Rag; reason?: string; small?: boolean }) {
  return (
    <span title={reason}>
      <Chip label={RAG_LABELS[rag]} color={RAG_COLORS[rag]} small={small} />
    </span>
  );
}

/** RAG as a left-edge bar (§6.1) — used on Kanban cards. */
export function ragEdge(rag: Rag): React.CSSProperties {
  return { boxShadow: `inset 4px 0 0 0 ${RAG_COLORS[rag]}` };
}
export function ragColor(rag: Rag): string {
  return RAG_COLORS[rag];
}

export function Modal({
  title, children, onClose, wide,
}: { title: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  const bodyRef = useRef<HTMLDivElement>(null);
  // Latest onClose behind a ref: callers often pass inline closures, and the
  // mount-only effect below must never re-run because of a new prop identity —
  // re-running it used to steal focus from whatever the user was typing in.
  const closeRef = useRef(onClose);
  useEffect(() => { closeRef.current = onClose; });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && closeRef.current();
    window.addEventListener("keydown", onKey);
    // Initial focus goes to the first control in the body — the header ✕ is
    // deliberately excluded so it can never end up focused instead of a field.
    bodyRef.current?.querySelector<HTMLElement>("input, select, textarea, button")?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-ink/40 p-4 pt-[8vh]" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-label={title}
        className={`w-full ${wide ? "max-w-3xl" : "max-w-lg"} rounded-xl bg-surface shadow-lift`}>
        <div className="flex items-center justify-between border-b border-hairline px-5 py-3.5">
          <h2 className="text-base font-semibold">{title}</h2>
          <button onClick={onClose} aria-label="Close dialog"
            className="rounded p-1 text-muted hover:bg-canvas hover:text-ink">✕</button>
        </div>
        <div ref={bodyRef} className="px-5 py-4">{children}</div>
      </div>
    </div>
  );
}

export function Btn({
  children, onClick, kind = "secondary", type = "button", disabled, small, title,
}: {
  children: ReactNode; onClick?: () => void; kind?: "primary" | "secondary" | "danger" | "ghost";
  type?: "button" | "submit"; disabled?: boolean; small?: boolean; title?: string;
}) {
  const styles = {
    primary: "bg-primary text-white hover:bg-primary/90",
    secondary: "border border-hairline bg-surface text-ink hover:bg-canvas",
    danger: "border border-rag-red/40 bg-surface text-rag-red hover:bg-rag-red/5",
    ghost: "text-muted hover:bg-canvas hover:text-ink",
  }[kind];
  return (
    <button type={type} onClick={onClick} disabled={disabled} title={title}
      className={`rounded-lg font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${small ? "px-2.5 py-1 text-xs" : "px-3.5 py-1.5 text-sm"} ${styles}`}>
      {children}
    </button>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-muted">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-muted">{hint}</span>}
    </label>
  );
}

export const inputCls =
  "w-full rounded-lg border border-hairline bg-surface px-3 py-1.5 text-sm text-ink placeholder:text-muted/60 focus:border-accent focus:outline-none";

export function Skeleton({ className }: { className?: string }) {
  return <div className={`skeleton ${className ?? "h-5 w-full"}`} aria-hidden />;
}

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-dashed border-hairline bg-surface/60 px-6 py-10 text-center">
      <p className="text-sm font-medium text-muted">{title}</p>
      {hint && <p className="mt-1 text-xs text-muted/80">{hint}</p>}
    </div>
  );
}

export function Card({ children, className, style }: { children: ReactNode; className?: string; style?: React.CSSProperties }) {
  return <div className={`rounded-xl border border-hairline bg-surface shadow-card ${className ?? ""}`} style={style}>{children}</div>;
}

export function Mono({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={`font-mono text-[0.92em] ${className ?? ""}`}>{children}</span>;
}

/** CSV export link — works against the server normally, generates the file in-browser in demo mode. */
export function CsvLink({ href, children, disabled }: { href: string; children: ReactNode; disabled?: boolean }) {
  return (
    <a
      href={href}
      aria-disabled={disabled}
      className={`inline-block rounded-lg px-3.5 py-1.5 text-sm font-medium ${
        disabled ? "pointer-events-none bg-hairline text-muted" : "border border-hairline bg-surface hover:bg-canvas"
      }`}
      onClick={(e) => {
        e.preventDefault();
        if (!disabled) csvDownload(href);
      }}
    >
      {children}
    </a>
  );
}
