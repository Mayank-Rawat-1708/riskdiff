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
  formatted_yaml: string;
  warnings: string[];
}

export interface Turn {
  role: "analyst" | "agent";
  text: string;
  at: string;
  backtest?: BacktestResult | null;
  commitMsg?: string | null;
  unexpectedFileChanges?: string[];
  providerAttempts?: ProviderAttempt[];
}

export interface Proposal {
  id: string;
  branch: string;
  incidentDescription: string;
  createdAt: string;
  turns: Turn[];
  recovered: boolean;
  diff?: string;
  hadChanges?: boolean;
}

export interface Status {
  repoMode: "remote" | "local-only";
  runtimeMode: string;
  modelChain: string[];
  hasGitRepoUrl: boolean;
}

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `${res.status} ${res.statusText}`);
  return body as T;
}

export const api = {
  status: () => req<Status>("/api/status"),
  rules: () => req<{ yaml: string; rules: RuleSummary[]; history: HistoryEntry[] }>("/api/rules"),
  commitDiff: (sha: string) => req<{ diff: string }>(`/api/rules/history/${sha}`),
  revert: (sha: string, note: string) =>
    req<{ yaml: string; rules: RuleSummary[]; history: HistoryEntry[] }>("/api/rules/revert", {
      method: "POST",
      body: JSON.stringify({ sha, note }),
    }),
  listProposals: () => req<{ proposals: Proposal[] }>("/api/proposals"),
  propose: (incidentDescription: string) =>
    req<Proposal>("/api/proposals", { method: "POST", body: JSON.stringify({ incidentDescription }) }),
  iterate: (id: string, feedback: string) =>
    req<Proposal>(`/api/proposals/${id}/iterate`, { method: "POST", body: JSON.stringify({ feedback }) }),
  approve: (id: string, analystNote: string) =>
    req<{ ok: true }>(`/api/proposals/${id}/approve`, { method: "POST", body: JSON.stringify({ analystNote }) }),
  reject: (id: string, analystNote: string) =>
    req<{ ok: true }>(`/api/proposals/${id}/reject`, { method: "POST", body: JSON.stringify({ analystNote }) }),
};
