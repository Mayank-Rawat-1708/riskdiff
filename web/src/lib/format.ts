export function pct(n: number | null | undefined): string {
  return n === null || n === undefined ? "—" : `${(n * 100).toFixed(1)}%`;
}

export function pp(n: number): string {
  return `${n > 0 ? "+" : n < 0 ? "−" : ""}${Math.abs(n * 100).toFixed(1)}pp`;
}

export function signed(n: number): string {
  return `${n > 0 ? "+" : n < 0 ? "−" : ""}${Math.abs(n)}`;
}

export function shortTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function relative(iso: string): string {
  const secs = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (!Number.isFinite(secs)) return "";
  if (secs < 45) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString([], { month: "short", day: "numeric" });
}

export function elapsed(iso: string, now: number): string {
  const secs = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return m > 0 ? `${m}m ${String(s).padStart(2, "0")}s` : `${s}s`;
}
