export interface RuleSummary {
  id: string;
  description: string;
  severity?: string;
  action?: string;
}

export interface HistoryEntry {
  sha: string;
  shortSha: string;
  date: string;
  message: string;
  author: string;
}

export interface ProviderAttempt {
  model: string;
  label: string;
  ok: boolean;
  error?: string;
}

export interface BacktestResult {
  current: Record<string, unknown>;
  candidate: Record<string, unknown>;
  delta: Record<string, unknown>;
  formatted_yaml: string;
  warnings: string[];
}

export interface ProposalState {
  id: string;
  branch: string;
  worktreeDir: string;
  status: "open" | "approved" | "rejected";
  createdAt: string;
  incidentDescription: string;
  turns: ProposalTurn[];
}

export interface ProposalTurn {
  role: "analyst" | "agent";
  text: string;
  at: string;
  backtest?: BacktestResult | null;
  commitMsg?: string | null;
  unexpectedFileChanges?: string[];
  providerAttempts?: ProviderAttempt[];
}
