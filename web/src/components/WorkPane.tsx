import { useEffect, useRef, useState } from "react";
import type { Proposal, Status, Turn } from "../api";
import { elapsed, shortTime } from "../lib/format";
import { Notice } from "./Notice";
import { ProviderTrail } from "./ProviderTrail";

function submitOnCmdEnter(fn: () => void) {
  return (e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      fn();
    }
  };
}

/** Everything the agent did that its own RULES.md says it shouldn't
 *  have. Surfaced at the turn that did it rather than aggregated —
 *  hiding an agent's misbehaviour is exactly backwards for a tool whose
 *  job is governing risk policy. */
function TurnWarnings({ turn }: { turn: Turn }) {
  return (
    <>
      {turn.backtestError && (
        <Notice kind="pending" title="The backtest failed, so this change is unvalidated">
          {turn.backtestError}
          <div className="mono">RULES.md item 3: a rule change with no backtest is a guess, not a proposal.</div>
        </Notice>
      )}
      {!turn.backtestError && !turn.backtest && turn.text.trim() && (
        <Notice kind="pending" title="No backtest attached">
          The agent answered without running the backtest tool. Treat the change as unvalidated — RULES.md item 3
          requires one.
        </Notice>
      )}
      {!turn.commitMsg && turn.text.trim() && (
        <Notice kind="pending" title="No COMMIT_MSG line">
          The agent didn't end its response with one, so the server generated a fallback commit message. RULES.md item
          7 was not followed.
        </Notice>
      )}
      {turn.noRulesetChange && turn.text.trim() && (
        <Notice kind="pending" title="No rule was changed">
          The agent replied but left rules/active-ruleset.yaml untouched. There is nothing to merge from this turn.
        </Notice>
      )}
      {!!turn.unexpectedFileChanges?.length && (
        <Notice kind="error" title="The agent edited files outside the ruleset">
          <div className="mono">{turn.unexpectedFileChanges.join(", ")}</div>
          These are on the proposal branch and will come across with the merge if you approve it.
        </Notice>
      )}
    </>
  );
}

function AgentWorking({ proposal }: { proposal: Proposal }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="working-block" aria-live="polite">
      <div className="bars" aria-hidden="true">
        <i />
        <i />
        <i />
      </div>
      <div>
        <div className="what">{proposal.phaseLabel ?? "Working"}</div>
        <div className="detail">
          Reading the live ruleset and recent memory, editing one rule on{" "}
          <span className="mono">{proposal.branch}</span>, then backtesting it against the historical set.
          {proposal.startedAt && (
            <>
              {" "}
              <span className="elapsed">{elapsed(proposal.startedAt, now)}</span> elapsed.
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export function WorkPane({
  proposal,
  status,
  busy,
  incident,
  feedback,
  onIncidentChange,
  onFeedbackChange,
  onPropose,
  onIterate,
  onCancel,
  onDiscard,
}: {
  proposal: Proposal | null;
  status: Status | null;
  busy: string | null;
  incident: string;
  feedback: string;
  onIncidentChange: (v: string) => void;
  onFeedbackChange: (v: string) => void;
  onPropose: () => void;
  onIterate: () => void;
  onCancel: () => void;
  onDiscard: () => void;
}) {
  const noModels = status !== null && status.modelChain.length === 0;
  const bodyRef = useRef<HTMLDivElement>(null);
  const turnCount = proposal?.turns.length ?? 0;

  useEffect(() => {
    bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight, behavior: "smooth" });
  }, [turnCount, proposal?.phase]);

  if (!proposal) {
    return (
      <section className="pane work" aria-label="New proposal">
        <div className="pane-head">
          <h2>New proposal</h2>
          <span className="grow" />
          <span className="sub">nothing open</span>
        </div>

        <div className="pane-body" ref={bodyRef}>
          <div className="empty">
            <strong>Describe what you're seeing.</strong>
            <p>
              A chargeback cluster, a complaint from the review queue, a pattern you noticed in the overnight batch —
              plain language is fine.
            </p>
            <p>
              The agent opens a branch, reads the live ruleset and what this business has already tried, changes exactly
              one rule, and backtests it against 600 historical transactions before handing it back.
            </p>
            <p>Nothing reaches the live ruleset until you merge it yourself.</p>
          </div>
        </div>

        <div className="composer">
          {noModels && (
            <div style={{ marginBottom: 10 }}>
              <Notice kind="error" title="No model provider configured">
                Set <span className="mono">GROQ_API_KEY</span>, <span className="mono">OPENAI_API_KEY</span> or{" "}
                <span className="mono">ANTHROPIC_API_KEY</span> in <span className="mono">.env</span> and restart. Every
                git operation — history, diffs, rollback — works without one; only drafting needs a model.
              </Notice>
            </div>
          )}
          <textarea
            className="field"
            value={incident}
            onChange={(e) => onIncidentChange(e.target.value)}
            onKeyDown={submitOnCmdEnter(onPropose)}
            rows={4}
            disabled={noModels}
            aria-label="Describe the pattern or incident"
            placeholder="Three chargebacks this week, all under ₹50k from devices first seen that day. Feels like the velocity threshold is too high."
          />
          <div className="btn-row" style={{ marginTop: 10 }}>
            <button className="btn primary" onClick={onPropose} disabled={!!busy || !incident.trim() || noModels}>
              Draft a rule change
            </button>
            <span className="grow" />
            <span className="hint">
              <span className="kbd">⌘</span>
              <span className="kbd">↵</span>
            </span>
          </div>
        </div>
      </section>
    );
  }

  const running = proposal.phase === "running";
  const lastAgentTurn = [...proposal.turns].reverse().find((t) => t.role === "agent");
  const hasOutput = proposal.turns.some((t) => t.role === "agent" && t.text.trim());

  return (
    <section className="pane work" aria-label="Open proposal">
      <div className="pane-head">
        <h2>Proposal</h2>
        <span className="sub" title={proposal.branch}>
          {proposal.branch}
        </span>
        <span className="grow" />
        <span className="sub">
          {proposal.turns.length} {proposal.turns.length === 1 ? "turn" : "turns"}
        </span>
      </div>

      <div className="work-head">
        <div className="incident">{proposal.incidentDescription}</div>
        <div className="meta">
          <span className="chip accent">worktree branch</span>
          {proposal.behindMain > 0 && (
            <span className="chip">
              {proposal.behindMain} {proposal.behindMain === 1 ? "commit" : "commits"} behind main
            </span>
          )}
          {lastAgentTurn?.costUsd ? <span className="chip">${lastAgentTurn.costUsd.toFixed(4)}</span> : null}
        </div>
      </div>

      <div className="pane-body" ref={bodyRef}>
        <div className="turns">
          {proposal.recovered && (
            <div style={{ paddingTop: 14 }}>
              <Notice kind="info" title="Recovered after a server restart">
                {proposal.turns.length > 0
                  ? "The conversation below was read back from the transcript committed on this branch."
                  : "The branch, its commits and its diff survived. The conversation did not — this proposal predates the on-branch transcript."}
              </Notice>
            </div>
          )}

          {proposal.conflict && (
            <div style={{ paddingTop: 14 }}>
              <Notice kind="error" title="This branch no longer applies to main">
                <span className="mono">{proposal.conflict.paths.join(", ")}</span> changed on main after this proposal
                opened, so the merge was refused and unwound — main is untouched. Reject this one and re-draft against
                the current ruleset.
              </Notice>
            </div>
          )}

          {proposal.lastError && proposal.phase === "failed" && (
            <div style={{ paddingTop: 14 }}>
              <Notice kind="error" title="The agent run failed">
                {proposal.lastError} Nothing was written to the branch. The attempts are listed below.
              </Notice>
            </div>
          )}

          {proposal.phase === "cancelled" && (
            <div style={{ paddingTop: 14 }}>
              <Notice kind="info" title="Run stopped">
                You stopped this run. Anything the agent had already written to the branch is still there; send a
                revision to pick it back up.
              </Notice>
            </div>
          )}

          {proposal.turns.map((turn, i) => (
            <article className={`turn ${turn.role} enter`} key={i}>
              <div className="turn-head">
                <span className="turn-who">{turn.role === "analyst" ? "You" : "Riska"}</span>
                <span className="turn-time">{shortTime(turn.at)}</span>
              </div>
              {turn.text.trim() ? (
                <div className="turn-body">{turn.text}</div>
              ) : (
                <div className="turn-body" style={{ color: "var(--text-3)" }}>
                  No response — every provider in the chain failed before one answered.
                </div>
              )}
              {turn.role === "agent" && (
                <div className="turn-foot">
                  {turn.commitMsg && (
                    <div className="commit-line">
                      <span>commit</span>
                      <span className="msg">{turn.commitMsg}</span>
                    </div>
                  )}
                  <TurnWarnings turn={turn} />
                  <ProviderTrail attempts={turn.providerAttempts} />
                </div>
              )}
            </article>
          ))}

          {running && <AgentWorking proposal={proposal} />}
        </div>
      </div>

      <div className="composer">
        {running ? (
          <div className="btn-row">
            <button className="btn danger" onClick={onCancel}>
              Stop this run
            </button>
            <span className="grow" />
            <span className="hint">The branch keeps whatever was already written.</span>
          </div>
        ) : (
          <>
            <textarea
              className="field"
              value={feedback}
              onChange={(e) => onFeedbackChange(e.target.value)}
              onKeyDown={submitOnCmdEnter(onIterate)}
              rows={3}
              aria-label="Ask for a revision"
              placeholder="Push back — 'too many false positives, try ₹35,000 instead' or 'check 36 hours as a middle ground'"
            />
            <div className="btn-row" style={{ marginTop: 10 }}>
              <button className="btn" onClick={onIterate} disabled={!!busy || !feedback.trim() || noModels}>
                Send revision
              </button>
              {!hasOutput && (
                <button className="btn ghost" onClick={onDiscard} disabled={!!busy}>
                  Discard branch
                </button>
              )}
              <span className="grow" />
              <span className="hint">
                <span className="kbd">⌘</span>
                <span className="kbd">↵</span>
              </span>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
