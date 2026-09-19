import type { CommitDetail, HistoryEntry, Proposal, RuleSummary } from "../api";
import { Backtest } from "./Backtest";
import { DiffView } from "./DiffView";
import { Notice } from "./Notice";

function MemoryEntry({ memoryDiff }: { memoryDiff: string }) {
  const added = memoryDiff
    .split("\n")
    .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
    .map((l) => l.slice(1))
    .join("\n")
    .trim();
  if (!added) return null;
  return (
    <div className="ev-section">
      <div className="ev-head">
        <h3>What went into the agent's memory</h3>
        <span className="note">agent/memory/MEMORY.md</span>
      </div>
      <div className="tradeoff" style={{ whiteSpace: "pre-wrap" }}>
        {added}
      </div>
    </div>
  );
}

export function EvidencePane({
  proposal,
  commit,
  commitDetail,
  commitLoading,
  rules,
  note,
  busy,
  landed,
  onNoteChange,
  onApprove,
  onReject,
  onRevert,
  onClearCommit,
}: {
  proposal: Proposal | null;
  commit: HistoryEntry | null;
  commitDetail: CommitDetail | null;
  commitLoading: boolean;
  rules: RuleSummary[];
  note: string;
  busy: string | null;
  landed: boolean;
  onNoteChange: (v: string) => void;
  onApprove: () => void;
  onReject: () => void;
  onRevert: () => void;
  onClearCommit: () => void;
}) {
  const ruleIds = rules.map((r) => r.id);

  // Inspecting a past commit takes over the pane: you are looking at
  // what already happened, not at what's being proposed.
  if (commit) {
    return (
      <section className="pane" aria-label="Commit detail">
        <div className="pane-head">
          <h2>{commit.kind === "decision" ? "Recorded decision" : "Past change"}</h2>
          <span className="sub">{commit.shortSha}</span>
          <span className="grow" />
          <button className="btn ghost sm" onClick={onClearCommit}>
            Close
          </button>
        </div>

        <div className="pane-body">
          <div className="evidence">
            <div className="ev-section">
              <div className="ev-head">
                <h3>{commit.message}</h3>
              </div>
              <div className="trail">
                <div className="trail-row">
                  <span className="label">{commit.shortSha}</span>
                  <span className="why">
                    {new Date(commit.date).toLocaleString()} · {commit.author}
                  </span>
                </div>
              </div>
            </div>

            {commitLoading ? (
              <div className="ev-section">
                <div className="diff">
                  <div className="diff-empty">Loading the diff…</div>
                </div>
              </div>
            ) : (
              <>
                {commit.touchesRuleset && (
                  <div className="ev-section">
                    <div className="ev-head">
                      <h3>Ruleset change</h3>
                    </div>
                    <DiffView
                      diff={commitDetail?.rulesetDiff ?? ""}
                      emptyLabel="This commit didn't change the ruleset."
                    />
                  </div>
                )}
                {!commit.touchesRuleset && (
                  <div className="ev-section">
                    <Notice kind="info" title="No rule changed in this commit">
                      This is a decision record — a proposal was rejected, so only the memory log moved. The branch was
                      deleted; the reasoning was kept.
                    </Notice>
                  </div>
                )}
                <MemoryEntry memoryDiff={commitDetail?.memoryDiff ?? ""} />
              </>
            )}
          </div>
        </div>

        <div className="decision">
          {commit.canRevert ? (
            <>
              <div className="why">
                Rolling back writes the previous ruleset as a new commit. Nothing is rewritten, and this commit stays in
                the log.
              </div>
              <textarea
                className="field"
                value={note}
                onChange={(e) => onNoteChange(e.target.value)}
                rows={2}
                aria-label="Why are you rolling this back?"
                placeholder="Why are you rolling this back? Goes into the commit and the agent's memory."
              />
              <div className="btn-row">
                <button className="btn danger" onClick={onRevert} disabled={!!busy}>
                  Roll back to before this commit
                </button>
              </div>
            </>
          ) : (
            <div className="why">
              {commit.isRoot
                ? "This is the repository's first commit — there is no earlier ruleset to roll back to."
                : "This commit didn't change the ruleset, so there is no rule state to restore. Roll back the change it refers to instead."}
            </div>
          )}
        </div>
      </section>
    );
  }

  if (!proposal) {
    return (
      <section className="pane" aria-label="Evidence">
        <div className="pane-head">
          <h2>Evidence</h2>
          <span className="grow" />
          <span className="sub">nothing selected</span>
        </div>
        <div className="pane-body">
          <div className="empty">
            <strong>Nothing to review.</strong>
            <p>
              Start a proposal and the backtest and the ruleset diff land here — the two things a decision actually
              turns on.
            </p>
            <p>Or pick a commit from the decision history to see what a past change did and why it was made.</p>
          </div>
        </div>
      </section>
    );
  }

  const lastAgentTurn = [...proposal.turns].reverse().find((t) => t.role === "agent");
  const backtest = lastAgentTurn?.backtest ?? null;
  const running = proposal.phase === "running";
  const decidable = !running && proposal.hadChanges && !proposal.conflict;

  // The analyst is the authority and is never blocked from merging. But
  // a proposal that broke the agent's own rules shouldn't wear the same
  // confident green as one that didn't — the button says what it is.
  const hasOutput = proposal.turns.some((t) => t.role === "agent" && t.text.trim());
  // A proposal recovered from git without its transcript has no turns
  // but still has a real diff on its branch. That is the whole point of
  // keeping the state in git: the conversation is gone, the change is
  // not, and it can still be decided on.
  const recoveredOnly = !hasOutput && proposal.hadChanges;
  const decidableAtAll = hasOutput || proposal.hadChanges;
  const violations = [
    !backtest && "no backtest",
    !lastAgentTurn?.commitMsg && "no commit message",
    lastAgentTurn?.unexpectedFileChanges?.length && "files changed outside the ruleset",
  ].filter(Boolean) as string[];
  const clean = violations.length === 0;

  return (
    <section className="pane" aria-label="Evidence">
      <div className="pane-head">
        <h2>Evidence</h2>
        <span className="sub">against main</span>
        <span className="grow" />
        {proposal.hadChanges && !running && <span className="chip pending">awaiting your decision</span>}
      </div>

      <div className="pane-body">
        <div className="evidence">
          {running && proposal.turns.length === 0 ? (
            <div className="empty">
              <strong>The agent is drafting.</strong>
              <p>The backtest and the diff appear here the moment it hands the proposal back.</p>
            </div>
          ) : (
            <>
              <div className="ev-section">
                <div className="ev-head">
                  <h3>Backtest</h3>
                  <span className="grow" />
                  <span className="note">
                    {backtest ? `${backtest.current.total_transactions} historical transactions` : "not run"}
                  </span>
                </div>
                {backtest ? (
                  <Backtest backtest={backtest} ruleIds={ruleIds} />
                ) : (
                  <Notice
                    kind="pending"
                    title={recoveredOnly ? "The backtest went with the conversation" : "No backtest result attached"}
                  >
                    {recoveredOnly ? (
                      <>
                        This proposal was recovered from its branch after a restart. The rule change survived in git;
                        the backtest that justified it did not. Send a revision to have it re-run before you decide.
                      </>
                    ) : (
                      <>
                        {lastAgentTurn?.backtestError
                          ? `The backtest tool failed: ${lastAgentTurn.backtestError}`
                          : "The agent proposed a change without running one."}{" "}
                        RULES.md item 3 requires a backtest — treat this change as unvalidated, and prefer sending it
                        back over merging it.
                      </>
                    )}
                  </Notice>
                )}
              </div>

              <div className="ev-section">
                <div className="ev-head">
                  <h3>Ruleset diff</h3>
                  <span className="grow" />
                  <span className="note">proposal branch vs main</span>
                </div>
                <DiffView
                  diff={proposal.diff}
                  emptyLabel={
                    running
                      ? "The agent hasn't written to the branch yet."
                      : "No change to the ruleset on this branch — there is nothing here to merge."
                  }
                />
              </div>
            </>
          )}
        </div>
      </div>

      <div className={`decision ${landed ? "landed" : ""}`}>
        {proposal.conflict ? (
          <div className="why">
            This branch conflicts with main and can't be merged. Reject it to record the decision, then re-draft against
            the current ruleset.
          </div>
        ) : running ? (
          <div className="why">The agent is still working. Stop the run before deciding.</div>
        ) : recoveredOnly ? (
          <div className="why">
            The conversation that produced this is gone, but the branch and its diff are intact — decide from the diff,
            or send a revision to have the agent re-state its case.
          </div>
        ) : !decidableAtAll ? (
          /* Nothing was ever proposed, so there is nothing to decide.
             Recording a rejection here would put a decision in the
             agent's memory that the analyst never actually made. */
          <div className="why">
            The agent never produced a proposal, so there's nothing to approve or reject. Send a revision to try again,
            or discard the branch.
          </div>
        ) : clean ? (
          <div className="why">
            Approving squash-merges this branch into main and writes your note into the agent's memory in the same
            commit. Rejecting deletes the branch and records the decision anyway.
          </div>
        ) : (
          <div className="why warned">
            This proposal broke the agent's own rules — {violations.join(", ")}. You can still merge it; nothing here
            stops you. It just isn't validated.
          </div>
        )}
        {decidableAtAll && (
          <>
            <textarea
              className="field"
              value={note}
              onChange={(e) => onNoteChange(e.target.value)}
              rows={2}
              disabled={running}
              aria-label="Your reasoning"
              placeholder="Your reasoning — goes into the commit and the agent's memory, so it doesn't re-propose this next week."
            />
            <div className="btn-row">
              <button
                className={`btn ${clean && !recoveredOnly ? "approve" : ""}`}
                onClick={onApprove}
                disabled={!!busy || !decidable}
              >
                {clean && !recoveredOnly ? "Approve and merge" : "Merge anyway"}
              </button>
              <button className="btn danger" onClick={onReject} disabled={!!busy || running}>
                Reject
              </button>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
