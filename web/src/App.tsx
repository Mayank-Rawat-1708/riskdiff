import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api, type CommitDetail, type HistoryEntry, type Proposal, type RuleSummary, type Status } from "./api";
import { applyTheme, initialTheme, type Theme } from "./theme";
import { EvidencePane } from "./components/EvidencePane";
import { Notice } from "./components/Notice";
import { PolicyPane } from "./components/PolicyPane";
import { StatusBar } from "./components/StatusBar";
import { WorkPane } from "./components/WorkPane";

/** How often open proposals are re-read while the agent is working.
 *  Agent runs are asynchronous, so this is the progress channel. */
const POLL_MS = 1500;

export default function App() {
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [status, setStatus] = useState<Status | null>(null);
  const [rules, setRules] = useState<RuleSummary[]>([]);
  const [rulesetYaml, setRulesetYaml] = useState("");
  const [history, setHistory] = useState<HistoryEntry[]>([]);

  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [commit, setCommit] = useState<HistoryEntry | null>(null);
  const [commitDetail, setCommitDetail] = useState<CommitDetail | null>(null);
  const [commitLoading, setCommitLoading] = useState(false);

  const [incident, setIncident] = useState("");
  const [feedback, setFeedback] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);
  const [booted, setBooted] = useState(false);
  const [landed, setLanded] = useState(false);
  const [landedRuleIds, setLandedRuleIds] = useState<string[]>([]);

  const ruleIdsRef = useRef<string[]>([]);

  useEffect(() => applyTheme(theme), [theme]);

  const refreshRules = useCallback(async () => {
    const r = await api.rules();
    // Which rules changed in this refresh, so a merge is visible where
    // it landed rather than only in the commit list.
    const before = ruleIdsRef.current;
    const changed = r.rules.filter((x) => !before.includes(x.id)).map((x) => x.id);
    ruleIdsRef.current = r.rules.map((x) => x.id);
    setRules(r.rules);
    setRulesetYaml(r.yaml);
    setHistory(r.history);
    return changed;
  }, []);

  const refreshProposals = useCallback(async () => {
    const { proposals: list } = await api.listProposals();
    setProposals(list);
    return list;
  }, []);

  // Boot.
  useEffect(() => {
    (async () => {
      try {
        setStatus(await api.status());
        await refreshRules();
        const list = await refreshProposals();
        // Land on whatever needs a human first: a finished proposal
        // beats one still drafting.
        const ready = list.find((p) => p.phase !== "running" && p.hadChanges) ?? list[0];
        if (ready) setSelectedId(ready.id);
        setOffline(false);
      } catch (e) {
        setOffline(true);
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBooted(true);
      }
    })();
  }, [refreshRules, refreshProposals]);

  // Poll while any run is in flight.
  const anyRunning = proposals.some((p) => p.phase === "running");
  useEffect(() => {
    if (!anyRunning) return;
    const t = setInterval(async () => {
      try {
        await refreshProposals();
        setOffline(false);
      } catch {
        setOffline(true);
      }
    }, POLL_MS);
    return () => clearInterval(t);
  }, [anyRunning, refreshProposals]);

  const selected = proposals.find((p) => p.id === selectedId) ?? null;
  const version = rulesetYaml.match(/^version:\s*(\d+)/m)?.[1] ?? null;

  async function run<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
    setBusy(label);
    setError(null);
    try {
      const out = await fn();
      setOffline(false);
      return out;
    } catch (e) {
      if (e instanceof ApiError && e.status === 0) setOffline(true);
      setError(e instanceof Error ? e.message : String(e));
      return undefined;
    } finally {
      setBusy(null);
    }
  }

  async function onPropose() {
    if (!incident.trim()) return;
    const p = await run("Opening a branch", () => api.propose(incident));
    if (p) {
      setIncident("");
      setCommit(null);
      setSelectedId(p.id);
      await refreshProposals();
    }
  }

  async function onIterate() {
    if (!selected || !feedback.trim()) return;
    const p = await run("Sending the revision", () => api.iterate(selected.id, feedback));
    if (p) {
      setFeedback("");
      await refreshProposals();
    }
  }

  async function onCancel() {
    if (!selected) return;
    await run("Stopping the run", () => api.cancel(selected.id));
    await refreshProposals();
  }

  async function onDiscard() {
    if (!selected) return;
    const ok = await run("Discarding the branch", () => api.discard(selected.id));
    if (ok) {
      setSelectedId(null);
      await refreshProposals();
    }
  }

  async function afterDecision() {
    setNote("");
    setSelectedId(null);
    const changed = await refreshRules();
    setLandedRuleIds(changed);
    const list = await refreshProposals();
    if (list.length) setSelectedId(list[0].id);
  }

  async function onApprove() {
    if (!selected) return;
    const ok = await run("Merging into main", () => api.approve(selected.id, note));
    if (ok) {
      setLanded(true);
      setTimeout(() => setLanded(false), 1500);
      await afterDecision();
    } else {
      // A conflict leaves the proposal open with its conflict recorded;
      // re-reading it is what surfaces that state in the UI.
      await refreshProposals();
    }
  }

  async function onReject() {
    if (!selected) return;
    const ok = await run("Recording the rejection", () => api.reject(selected.id, note));
    if (ok) await afterDecision();
  }

  async function onSelectCommit(c: HistoryEntry) {
    if (commit?.sha === c.sha) {
      setCommit(null);
      return;
    }
    setCommit(c);
    setCommitDetail(null);
    setCommitLoading(true);
    setNote("");
    try {
      setCommitDetail(await api.commitDiff(c.sha));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCommitLoading(false);
    }
  }

  async function onRevert() {
    if (!commit) return;
    const r = await run("Rolling back", () => api.revert(commit.sha, note));
    if (r) {
      setRules(r.rules);
      setRulesetYaml(r.yaml);
      setHistory(r.history);
      ruleIdsRef.current = r.rules.map((x) => x.id);
      setCommit(null);
      setCommitDetail(null);
      setNote("");
      await refreshProposals();
    }
  }

  // Escape closes the commit inspector — the one modal-ish state here.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && commit) setCommit(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [commit]);

  return (
    <div className="shell">
      <StatusBar
        status={status}
        version={version}
        proposals={proposals}
        busy={busy}
        theme={theme}
        onToggleTheme={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
      />

      {(error || offline) && (
        <div style={{ padding: "10px 16px", borderBottom: "1px solid var(--line)", background: "var(--surface)" }}>
          {offline ? (
            <Notice kind="error" title="Lost contact with the workbench server">
              Nothing in git has changed. The page reconnects on its own once the server is back — everything already
              committed is safe on disk.
            </Notice>
          ) : (
            <Notice kind="error" title="That didn't go through">
              {error}
            </Notice>
          )}
        </div>
      )}

      <div className="panes">
        <PolicyPane
          rules={rules}
          version={version}
          history={history}
          proposals={proposals}
          selectedProposalId={selectedId}
          selectedSha={commit?.sha ?? null}
          landedRuleIds={landedRuleIds}
          onSelectProposal={(id) => {
            setSelectedId(id);
            setCommit(null);
            setNote("");
          }}
          onSelectCommit={onSelectCommit}
        />

        <WorkPane
          proposal={selected}
          status={status}
          busy={busy}
          incident={incident}
          feedback={feedback}
          onIncidentChange={setIncident}
          onFeedbackChange={setFeedback}
          onPropose={onPropose}
          onIterate={onIterate}
          onCancel={onCancel}
          onDiscard={onDiscard}
        />

        <EvidencePane
          proposal={selected}
          commit={commit}
          commitDetail={commitDetail}
          commitLoading={commitLoading}
          rules={rules}
          note={note}
          busy={busy}
          landed={landed}
          onNoteChange={setNote}
          onApprove={onApprove}
          onReject={onReject}
          onRevert={onRevert}
          onClearCommit={() => setCommit(null)}
        />
      </div>

      {!booted && <span className="visually-hidden">Loading the workbench…</span>}
    </div>
  );
}
