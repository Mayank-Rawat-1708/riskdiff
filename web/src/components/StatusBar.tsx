import type { Proposal, Status } from "../api";
import type { Theme } from "../theme";
import { MoonIcon, SunIcon } from "./icons";

export function StatusBar({
  status,
  version,
  proposals,
  busy,
  theme,
  onToggleTheme,
}: {
  status: Status | null;
  version: string | null;
  proposals: Proposal[];
  busy: string | null;
  theme: Theme;
  onToggleTheme: () => void;
}) {
  const noModels = status !== null && status.modelChain.length === 0;
  const running = proposals.filter((p) => p.phase === "running").length;
  const waiting = proposals.length - running;

  return (
    <header className="statusbar">
      <div className="brand">
        <span className="glyph" aria-hidden="true" />
        RiskDiff
      </div>

      <div className="items">
        <div className="stat">
          <span className="k">ruleset</span>
          <span className="v">v{version ?? "—"}</span>
        </div>

        <div className="stat">
          <span className={`dot ${status?.pushError ? "bad" : status?.repoMode === "remote" ? "ok" : "off"}`} />
          {status?.pushError
            ? "merged locally, push failed"
            : status?.repoMode === "remote"
              ? "pushing to origin"
              : "local-only repo"}
        </div>

        <div className="stat" title={status?.modelChain.join(" → ")}>
          <span className={`dot ${noModels ? "bad" : "ok"}`} />
          {status === null ? "connecting…" : noModels ? "no model provider" : status.modelChain[0]}
          {status && status.modelChain.length > 1 && (
            <span className="k">+{status.modelChain.length - 1} fallback</span>
          )}
        </div>

        {proposals.length > 0 && (
          <div className="stat">
            <span className={`dot ${waiting > 0 ? "pending" : "ok"}`} />
            {waiting > 0 && `${waiting} awaiting your decision`}
            {waiting > 0 && running > 0 && ", "}
            {running > 0 && `${running} drafting`}
          </div>
        )}
      </div>

      <div className="right">
        {busy && (
          <div className="working-pill">
            <span className="pulse" />
            {busy}
          </div>
        )}
        <button
          className="icon-btn"
          onClick={onToggleTheme}
          aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
          title={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
        >
          {theme === "dark" ? <SunIcon /> : <MoonIcon />}
        </button>
      </div>
    </header>
  );
}
