export interface RuleSummary {
  id: string;
  description: string;
  severity?: string;
  action?: string;
}

/**
 * One commit on `main` that touched the policy record. "Touched" means
 * the ruleset, the memory log, or both -- a rejection commits only
 * memory, and that is still a decision the analyst needs to see in the
 * timeline, so the history is keyed on both paths rather than on the
 * ruleset alone.
 */
export interface HistoryEntry {
  sha: string;
  shortSha: string;
  date: string;
  message: string;
  author: string;
  /** Root commit has no parent, so there is nothing to roll back to. */
  isRoot: boolean;
  touchesRuleset: boolean;
  touchesMemory: boolean;
  kind: "change" | "decision" | "seed";
  /** False when rolling back is structurally impossible (root commit,
   *  or the ruleset did not exist in the parent). */
  canRevert: boolean;
}

export interface ProviderAttempt {
  model: string;
  label: string;
  ok: boolean;
  error?: string;
  /** What the provider actually reported it ran, when it succeeded.
   *  Not always identical to the requested id. */
  resolvedModel?: string;
  ms?: number;
}

export interface BacktestScores {
  total_transactions: number;
  total_flagged: number;
  true_positives: number;
  false_positives: number;
  false_negatives: number;
  catch_rate: number | null;
  false_positive_rate: number | null;
  precision: number | null;
  flags_per_rule: Record<string, number>;
}

export interface BacktestResult {
  current: BacktestScores;
  candidate: BacktestScores;
  delta: {
    catch_rate: number | null;
    false_positive_rate: number | null;
    precision: number | null;
    total_flagged: number;
  };
  /** The live ruleset with only this change applied -- what the agent
   *  is told to write, so the file that was scored and the file that
   *  was committed can't drift apart. */
  patched_yaml: string;
  /** Plain-language list of the values the patch moved. */
  patch_summary: string[];
  warnings: string[];
}

export interface ProposalTurn {
  role: "analyst" | "agent";
  text: string;
  at: string;
  backtest?: BacktestResult | null;
  commitMsg?: string | null;
  unexpectedFileChanges?: string[];
  providerAttempts?: ProviderAttempt[];
  /** Set when the agent ran but produced no ruleset edit at all. */
  noRulesetChange?: boolean;
  /** The agent called `backtest` and the tool itself failed. */
  backtestError?: string | null;
  costUsd?: number | null;
}

/** What the agent is doing on this proposal right now. Agent runs are
 *  asynchronous: the POST that starts one returns immediately and the
 *  client polls, so a 60-second model call is a visible state rather
 *  than a hung request. */
export type AgentPhase = "idle" | "running" | "failed" | "cancelled";

export interface ProposalView {
  id: string;
  branch: string;
  incidentDescription: string;
  createdAt: string;
  turns: ProposalTurn[];
  /** Picked back up from its git worktree after a server restart. */
  recovered: boolean;
  phase: AgentPhase;
  phaseLabel: string | null;
  startedAt: string | null;
  lastError: string | null;
  diff: string;
  hadChanges: boolean;
  /** How many commits `main` has that this branch does not. Non-zero
   *  means main moved since the proposal opened, so approving it may
   *  conflict -- surfaced before the analyst clicks, not after. */
  behindMain: number;
  conflict: ConflictInfo | null;
}

export interface ConflictInfo {
  paths: string[];
  at: string;
}
