import { useCallback, useEffect, useState } from "react";
import { api, type HistoryEntry, type Proposal, type RuleSummary, type Status } from "./api";
import { BacktestPanel, DiffView, ProviderAttempts } from "./components";

export default function App() {
  const [status, setStatus] = useState<Status | null>(null);
  const [rules, setRules] = useState<RuleSummary[]>([]);
  const [rulesetYaml, setRulesetYaml] = useState("");
  const [history, setHistory] = useState<HistoryEntry[]>([]);

  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [diff, setDiff] = useState("");
  const [selectedCommit, setSelectedCommit] = useState<HistoryEntry | null>(null);
  const [commitDiff, setCommitDiff] = useState("");

  const [incident, setIncident] = useState("");
  const [feedback, setFeedback] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refreshRules = useCallback(async () => {
    const r = await api.rules();
    setRules(r.rules);
    setRulesetYaml(r.yaml);
    setHistory(r.history);
  }, []);

  useEffect(() => {
    (async () => {
      try {
        setStatus(await api.status());
        await refreshRules();
        const { proposals } = await api.listProposals();
        if (proposals.length) setProposal(proposals[0]);
      } catch (e) {
        setError(String(e));
      }
    })();
  }, [refreshRules]);

  const version = rulesetYaml.match(/^version:\s*(\d+)/m)?.[1];

  async function run<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
    setBusy(label);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return undefined;
    } finally {
      setBusy(null);
    }
  }

  async function onPropose() {
    if (!incident.trim()) return;
    const p = await run("Drafting a proposal", () => api.propose(incident));
    if (p) {
      setProposal(p);
      setDiff(p.diff ?? "");
      setIncident("");
      setSelectedCommit(null);
    }
  }

  async function onIterate() {
    if (!proposal || !feedback.trim()) return;
    const p = await run("Revising the proposal", () => api.iterate(proposal.id, feedback));
    if (p) {
      setProposal(p);
      setDiff(p.diff ?? "");
      setFeedback("");
    }
  }

  async function onApprove() {
    if (!proposal) return;
    const ok = await run("Merging to main", () => api.approve(proposal.id, note));
    if (ok) {
      setProposal(null);
      setDiff("");
      setNote("");
      await refreshRules();
    }
  }

  async function onReject() {
    if (!proposal) return;
    const ok = await run("Discarding the branch", () => api.reject(proposal.id, note));
    if (ok) {
      setProposal(null);
      setDiff("");
      setNote("");
      await refreshRules();
    }
  }

  async function onSelectCommit(c: HistoryEntry) {
    setSelectedCommit(c);
    setCommitDiff("");
    const r = await run("Loading commit", () => api.commitDiff(c.sha));
    if (r) setCommitDiff(r.diff);
  }

  async function onRevert() {
    if (!selectedCommit) return;
    const r = await run("Reverting", () => api.revert(selectedCommit.sha, note));
    if (r) {
      setRules(r.rules);
      setRulesetYaml(r.yaml);
      setHistory(r.history);
      setSelectedCommit(null);
      setCommitDiff("");
      setNote("");
    }
  }

  const lastAgentTurn = [...(proposal?.turns ?? [])].reverse().find((t) => t.role === "agent");
  const noModels = status && status.modelChain.length === 0;

  return (
    <div className="shell">
      <div className="statusbar">
        <div className="brand">
          RiskDiff <span>transaction policy workbench</span>
        </div>
        <div className="stat">
          ruleset <b>v{version ?? "?"}</b>
        </div>
        <div className="stat">
          <span className={`dot ${status?.repoMode === "remote" ? "ok" : "warn"}`} />
          {status?.repoMode === "remote" ? "pushing to origin" : "local-only repo"}
        </div>
        <div className="stat">
          <span className={`dot ${noModels ? "off" : "ok"}`} />
          {status ? (status.modelChain[0] ?? "no model configured") : "…"}
          {status && status.modelChain.length > 1 && (
            <span style={{ color: "var(--faint)" }}> +{status.modelChain.length - 1} fallback</span>
          )}
        </div>
        <div className="spacer" />
        {proposal && (
          <div className="proposal-chip">
            <span className="dot warn" />
            {proposal.branch}
          </div>
        )}
        {busy && (
          <div className="working">
            <span className="pulse" />
            {busy}…
          </div>
        )}
      </div>

      <div className="panes">
        {/* ---------- left: live policy + history ---------- */}
        <section className="pane">
          <div className="pane-head">
            <h2>Live ruleset</h2>
            <span className="sub">on main</span>
          </div>
          <div className="pane-body">
            {rules.map((r) => (
              <div className={`rule sev-${r.severity ?? "none"}`} key={r.id}>
                <div className="rule-id">{r.id}</div>
                <div className="rule-desc">{r.description}</div>
                <div className="rule-meta">
                  {r.severity ?? "—"} · {r.action ?? "—"}
                </div>
              </div>
            ))}

            <div className="history-head">Change history</div>
            {history.map((c) => (
              <button
                key={c.sha}
                className={`commit ${selectedCommit?.sha === c.sha ? "selected" : ""}`}
                onClick={() => onSelectCommit(c)}
              >
                <div className="commit-msg">{c.message}</div>
                <div className="commit-meta">
                  {c.shortSha} · {new Date(c.date).toLocaleDateString()}
                </div>
              </button>
            ))}
          </div>
        </section>

        {/* ---------- center: the work ---------- */}
        <section className="pane">
          <div className="pane-head">
            <h2>{proposal ? "Open proposal" : "New proposal"}</h2>
            <span className="sub">{proposal ? `${proposal.turns.length} turns` : "describe what you're seeing"}</span>
          </div>

          {!proposal && (
            <div className="composer">
              <textarea
                value={incident}
                onChange={(e) => setIncident(e.target.value)}
                placeholder="Three chargebacks this week, all under ₹50k from devices first seen that day. Feels like the velocity threshold is too high."
              />
              <div className="btn-row">
                <button className="btn primary" onClick={onPropose} disabled={!!busy || !incident.trim() || !!noModels}>
                  Draft a rule change
                </button>
                <span className="spacer" />
                {noModels && <span className="attempts failed">no model provider configured</span>}
              </div>
            </div>
          )}

          <div className="pane-body">
            {error && <div className="banner">{error}</div>}

            {!proposal && !error && (
              <div className="empty">
                <b>Nothing open.</b>
                Describe a fraud pattern or a complaint from the review queue. The agent drafts one rule change on its
                own branch, backtests it against 600 historical transactions, and hands it back for your decision.
                Nothing reaches the live ruleset until you approve it.
              </div>
            )}

            {proposal?.recovered && (
              <div className="warnbox">
                Recovered after a server restart. The branch and its commits survived; the conversation that produced
                them did not.
              </div>
            )}

            {proposal?.turns.map((t, i) => (
              <div className={`turn ${t.role}`} key={i}>
                <div className="turn-who">
                  {t.role === "analyst" ? "you" : "riska"}
                  <span>{new Date(t.at).toLocaleTimeString()}</span>
                </div>
                <div className="turn-body">{t.text}</div>
                {t.commitMsg && <div className="commit-msg-chip">commit: {t.commitMsg}</div>}
                {t.role === "agent" && !t.commitMsg && (
                  <div className="warnbox">
                    No COMMIT_MSG line in this response — the server used a generated fallback message. RULES.md item 7
                    was not followed.
                  </div>
                )}
                {!!t.unexpectedFileChanges?.length && (
                  <div className="warnbox">
                    Touched files outside the ruleset: {t.unexpectedFileChanges.join(", ")}
                  </div>
                )}
                {t.providerAttempts && <ProviderAttempts attempts={t.providerAttempts} />}
              </div>
            ))}
          </div>

          {proposal && (
            <div className="decision">
              <textarea
                value={feedback}
                onChange={(e) => setFeedback(e.target.value)}
                placeholder="Push back or ask for a revision — e.g. 'too many false positives, try ₹35k instead'"
              />
              <div className="btn-row">
                <button className="btn" onClick={onIterate} disabled={!!busy || !feedback.trim()}>
                  Send revision
                </button>
              </div>
            </div>
          )}
        </section>

        {/* ---------- right: evidence + decision ---------- */}
        <section className="pane">
          <div className="pane-head">
            <h2>{selectedCommit ? `Commit ${selectedCommit.shortSha}` : "Proposed change"}</h2>
            <span className="sub">
              {selectedCommit ? "from history" : proposal ? `vs main` : "nothing proposed"}
            </span>
          </div>

          <div className="pane-body">
            {selectedCommit ? (
              <>
                <div className="section-label">{selectedCommit.message}</div>
                <DiffView diff={commitDiff} />
                <div className="btn-row">
                  <button className="btn small" onClick={() => setSelectedCommit(null)}>
                    Back to current proposal
                  </button>
                </div>
              </>
            ) : proposal ? (
              <>
                {lastAgentTurn?.backtest && (
                  <>
                    <div className="section-label">Backtest against historical transactions</div>
                    <BacktestPanel backtest={lastAgentTurn.backtest} />
                  </>
                )}
                {!lastAgentTurn?.backtest && (
                  <div className="warnbox">
                    No backtest result attached to this proposal. RULES.md item 3 requires one — treat the change as
                    unvalidated.
                  </div>
                )}
                <div className="section-label">Ruleset diff</div>
                <DiffView diff={diff} />
              </>
            ) : (
              <div className="empty">
                <b>No proposal open.</b>
                Select a commit from the change history to inspect what a past rule change actually did, or start a new
                proposal.
              </div>
            )}
          </div>

          {(proposal || selectedCommit) && (
            <div className="decision">
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder={
                  selectedCommit
                    ? "Why are you rolling this back? Goes into the commit and the agent's memory."
                    : "Your reasoning — goes into the commit and the agent's memory."
                }
              />
              <div className="btn-row">
                {selectedCommit ? (
                  <button className="btn reject" onClick={onRevert} disabled={!!busy}>
                    Roll back to before this commit
                  </button>
                ) : (
                  <>
                    <button className="btn approve" onClick={onApprove} disabled={!!busy}>
                      Approve and merge
                    </button>
                    <button className="btn reject" onClick={onReject} disabled={!!busy}>
                      Reject
                    </button>
                  </>
                )}
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
