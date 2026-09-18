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
  isRoot: boolean;
  touchesRuleset: boolean;
  touchesMemory: boolean;
  kind: "change" | "decision" | "seed";
  canRevert: boolean;
}

export interface ProviderAttempt {
  model: string;
  label: string;
  ok: boolean;
  error?: string;
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
  patched_yaml: string;
  patch_summary: string[];
  warnings: string[];
}

export interface Turn {
  role: "analyst" | "agent";
  text: string;
  at: string;
  backtest?: BacktestResult | null;
  backtestError?: string | null;
  commitMsg?: string | null;
  unexpectedFileChanges?: string[];
  noRulesetChange?: boolean;
  providerAttempts?: ProviderAttempt[];
  costUsd?: number | null;
}

export type AgentPhase = "idle" | "running" | "failed" | "cancelled";

export interface Proposal {
  id: string;
  branch: string;
  incidentDescription: string;
  createdAt: string;
  turns: Turn[];
  recovered: boolean;
  phase: AgentPhase;
  phaseLabel: string | null;
  startedAt: string | null;
  lastError: string | null;
  diff: string;
  hadChanges: boolean;
  behindMain: number;
  conflict: { paths: string[]; at: string } | null;
}

export interface Status {
  repoMode: "remote" | "local-only";
  runtimeMode: string;
  modelChain: string[];
  hasGitRepoUrl: boolean;
  pushError: string | null;
}

export interface CommitDetail {
  rulesetDiff: string;
  memoryDiff: string;
}

/** An error the server described on purpose, rather than a stack trace
 *  that leaked out. `status` lets the UI tell a conflict (409) from a
 *  refusal (422) from something genuinely unexpected. */
export class ApiError extends Error {
  readonly status: number;
  readonly detail: unknown;
  constructor(message: string, status: number, detail?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.detail = detail;
  }
}

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    });
  } catch {
    throw new ApiError("Can't reach the workbench server. It may be restarting.", 0);
  }
  const body = (await res.json().catch(() => ({}))) as { error?: string; conflict?: string[] };
  if (!res.ok) throw new ApiError(body.error ?? `${res.status} ${res.statusText}`, res.status, body);
  return body as T;
}

export const api = {
  status: () => req<Status>("/api/status"),
  rules: () => req<{ yaml: string; rules: RuleSummary[]; history: HistoryEntry[] }>("/api/rules"),
  commitDiff: (sha: string) => req<CommitDetail>(`/api/rules/history/${sha}`),
  revert: (sha: string, note: string) =>
    req<{ yaml: string; rules: RuleSummary[]; history: HistoryEntry[] }>("/api/rules/revert", {
      method: "POST",
      body: JSON.stringify({ sha, note }),
    }),
  listProposals: () => req<{ proposals: Proposal[] }>("/api/proposals"),
  getProposal: (id: string) => req<Proposal>(`/api/proposals/${id}`),
  propose: (incidentDescription: string) =>
    req<Proposal>("/api/proposals", { method: "POST", body: JSON.stringify({ incidentDescription }) }),
  iterate: (id: string, feedback: string) =>
    req<Proposal>(`/api/proposals/${id}/iterate`, { method: "POST", body: JSON.stringify({ feedback }) }),
  cancel: (id: string) => req<Proposal>(`/api/proposals/${id}/cancel`, { method: "POST" }),
  approve: (id: string, analystNote: string) =>
    req<{ ok: true }>(`/api/proposals/${id}/approve`, { method: "POST", body: JSON.stringify({ analystNote }) }),
  reject: (id: string, analystNote: string) =>
    req<{ ok: true }>(`/api/proposals/${id}/reject`, { method: "POST", body: JSON.stringify({ analystNote }) }),
  discard: (id: string) => req<{ ok: true }>(`/api/proposals/${id}/discard`, { method: "POST" }),
};
