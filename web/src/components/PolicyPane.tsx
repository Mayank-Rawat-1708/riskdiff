import type { HistoryEntry, Proposal, RuleSummary } from "../api";
import { relative } from "../lib/format";

function ProposalRow({
  proposal,
  selected,
  onSelect,
}: {
  proposal: Proposal;
  selected: boolean;
  onSelect: () => void;
}) {
  const running = proposal.phase === "running";
  const failed = proposal.phase === "failed";
  const stale = proposal.behindMain > 0 || proposal.conflict !== null;

  return (
    <button className={`prop ${selected ? "selected" : ""}`} onClick={onSelect} aria-current={selected}>
      <div className="prop-top">
        <span className={`dot ${running ? "pending" : failed ? "bad" : "pending"}`} />
        <span className="prop-title">{proposal.incidentDescription}</span>
      </div>
      <div className="prop-branch" title={proposal.branch}>
        {proposal.branch}
      </div>
      <div className="prop-meta">
        {/* Chips call out the exceptions. "Awaiting your decision" is
            the normal state of everything in this list and is already
            said by the amber marker — repeating it on every row turns
            the one colour that means "act on this" into wallpaper. */}
        {running && (
          <span className="chip pending">
            <span className="spinner" />
            drafting
          </span>
        )}
        {failed && <span className="chip bad">run failed</span>}
        {!running && !failed && !proposal.hadChanges && <span className="chip">no rule change</span>}
        {proposal.conflict && <span className="chip bad">conflicts with main</span>}
        {!proposal.conflict && stale && <span className="chip">main moved</span>}
        <span className="prop-age">{relative(proposal.createdAt)}</span>
      </div>
    </button>
  );
}

export function PolicyPane({
  rules,
  version,
  history,
  proposals,
  selectedProposalId,
  selectedSha,
  landedRuleIds,
  onSelectProposal,
  onSelectCommit,
}: {
  rules: RuleSummary[];
  version: string | null;
  history: HistoryEntry[];
  proposals: Proposal[];
  selectedProposalId: string | null;
  selectedSha: string | null;
  landedRuleIds: string[];
  onSelectProposal: (id: string) => void;
  onSelectCommit: (c: HistoryEntry) => void;
}) {
  return (
    <section className="pane" aria-label="Policy state">
      <div className="pane-head">
        <h2>Policy</h2>
        <span className="grow" />
        <span className="sub">main</span>
      </div>

      <div className="pane-body">
        {proposals.length > 0 && (
          <>
            <div className="section">
              <h3>Open proposals</h3>
              <span className="count">{proposals.length}</span>
            </div>
            {proposals.map((p) => (
              <ProposalRow
                key={p.id}
                proposal={p}
                selected={p.id === selectedProposalId}
                onSelect={() => onSelectProposal(p.id)}
              />
            ))}
          </>
        )}

        <div className="section">
          <h3>Live ruleset</h3>
          <span className="count">v{version ?? "—"}</span>
          <span className="grow" />
          <span className="count">
            {rules.length} {rules.length === 1 ? "rule" : "rules"}
          </span>
        </div>

        {rules.length === 0 ? (
          <div className="empty">
            <strong>No rules parsed</strong>
            <p>The ruleset on main is empty or couldn't be read. Check the server log.</p>
          </div>
        ) : (
          rules.map((r) => (
            <div className={`rule sev-${r.severity ?? "none"} ${landedRuleIds.includes(r.id) ? "landed" : ""}`} key={r.id}>
              <div className="rule-id">{r.id}</div>
              <div className="rule-desc">{r.description}</div>
              {/* The thresholds that actually fire. The description above
                  is prose and can drift from them — after a threshold
                  merge it routinely does, and an analyst reading only the
                  sentence would be reading last month's rule. */}
              {r.condition && Object.keys(r.condition).length > 0 && (
                <dl className="cond">
                  {Object.entries(r.condition).map(([k, v]) => (
                    <div className="cond-pair" key={k}>
                      <dt>{k === "type" ? "kind" : k}</dt>
                      <dd>{v}</dd>
                    </div>
                  ))}
                </dl>
              )}
              <div className="rule-meta">
                <span>{r.severity ?? "—"}</span>
                <span className="sep">/</span>
                <span>{r.action ?? "—"}</span>
              </div>
            </div>
          ))
        )}

        <div className="section">
          <h3>Decision history</h3>
          <span className="grow" />
          <span className="count">on main</span>
        </div>

        <div className="timeline">
          {history.length === 0 && <div className="empty">Nothing recorded yet.</div>}
          {history.map((c) => (
            <button
              key={c.sha}
              className={`commit kind-${c.kind} ${selectedSha === c.sha ? "selected" : ""}`}
              onClick={() => onSelectCommit(c)}
              aria-current={selectedSha === c.sha}
            >
              <div className="commit-msg">{c.message}</div>
              <div className="commit-meta">
                <span className="sha">{c.shortSha}</span>
                <span>{relative(c.date)}</span>
                {c.kind === "decision" && <span>· decision only</span>}
                {c.kind === "seed" && <span>· first commit</span>}
              </div>
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}
