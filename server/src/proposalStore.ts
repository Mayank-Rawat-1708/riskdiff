import { simpleGit } from "simple-git";
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { type ProposalHandle, transcriptRelFor } from "./repoManager.js";
import type { AgentPhase, ConflictInfo, ProposalTurn } from "./types.js";

export interface StoredProposal {
  id: string;
  handle: ProposalHandle;
  incidentDescription: string;
  createdAt: string;
  turns: ProposalTurn[];
  recovered: boolean;
  phase: AgentPhase;
  phaseLabel: string | null;
  startedAt: string | null;
  lastError: string | null;
  conflict: ConflictInfo | null;
  /** Live only; lets the analyst stop a run that's going nowhere. */
  abort: AbortController | null;
}

const store = new Map<string, StoredProposal>();

function idFor(branch: string): string {
  return Buffer.from(branch).toString("base64url");
}

export function create(handle: ProposalHandle, incidentDescription: string): StoredProposal {
  const p: StoredProposal = {
    id: idFor(handle.branch),
    handle,
    incidentDescription,
    createdAt: new Date().toISOString(),
    turns: [],
    recovered: false,
    phase: "idle",
    phaseLabel: null,
    startedAt: null,
    lastError: null,
    conflict: null,
    abort: null,
  };
  store.set(p.id, p);
  return p;
}

export function get(id: string): StoredProposal | undefined {
  return store.get(id);
}

export function list(): StoredProposal[] {
  return [...store.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function remove(id: string): void {
  store.delete(id);
}

export function addTurn(id: string, turn: ProposalTurn): void {
  const p = store.get(id);
  if (p) p.turns.push(turn);
}

export function setPhase(id: string, phase: AgentPhase, label: string | null = null): void {
  const p = store.get(id);
  if (!p) return;
  p.phase = phase;
  p.phaseLabel = label;
  if (phase === "running") {
    p.startedAt = new Date().toISOString();
    p.lastError = null;
  } else {
    p.startedAt = null;
    p.abort = null;
  }
}

export function setError(id: string, message: string): void {
  const p = store.get(id);
  if (!p) return;
  p.phase = "failed";
  p.phaseLabel = null;
  p.startedAt = null;
  p.abort = null;
  p.lastError = message;
}

export function setConflict(id: string, conflict: ConflictInfo | null): void {
  const p = store.get(id);
  if (p) p.conflict = conflict;
}

/**
 * The on-branch record of the conversation. Written into the proposal's
 * own worktree and committed with the same commit as the rule edit, so
 * the reasoning is as git-native as the rule: it survives a server
 * restart, it diffs, and on approval it lands on `main` as a permanent
 * audit trail beside the change it argued for.
 */
export interface Transcript {
  schema: 1;
  id: string;
  branch: string;
  status: "open" | "approved" | "rejected";
  incident: string;
  createdAt: string;
  decidedAt: string | null;
  analystNote: string | null;
  turns: ProposalTurn[];
}

export function transcriptFor(p: StoredProposal): { relPath: string; content: string } {
  const doc: Transcript = {
    schema: 1,
    id: p.id,
    branch: p.handle.branch,
    status: "open",
    incident: p.incidentDescription,
    createdAt: p.createdAt,
    decidedAt: null,
    analystNote: null,
    turns: p.turns,
  };
  // Pretty-printed rather than compact: this file is meant to be read in
  // a diff like everything else in the repo.
  return { relPath: transcriptRelFor(p.handle.branch), content: JSON.stringify(doc, null, 2) + "\n" };
}

/**
 * On boot, picks up any `proposal/*` worktrees left over from a previous
 * server process (a Render restart, a crash) and restores them from the
 * branch itself -- including the conversation, which is committed on the
 * branch rather than held in server memory. A proposal whose branch has
 * no transcript yet (the process died mid-first-turn) comes back with
 * its git state and an honest note that the conversation is missing.
 */
export async function reconcileFromGit(primaryDir: string): Promise<void> {
  const g = simpleGit(primaryDir);
  await g.raw(["worktree", "prune"]).catch(() => undefined);
  const raw = await g.raw(["worktree", "list", "--porcelain"]).catch(() => "");
  const blocks = raw.split(/\n\n+/).filter(Boolean);

  for (const block of blocks) {
    const dirLine = block.match(/^worktree (.+)$/m);
    const branchLine = block.match(/^branch refs\/heads\/(.+)$/m);
    if (!dirLine || !branchLine) continue;
    const branch = branchLine[1];
    if (!branch.startsWith("proposal/")) continue;

    const worktreeDir = dirLine[1];
    const stillThere = await fs
      .access(worktreeDir)
      .then(() => true)
      .catch(() => false);
    if (!stillThere) continue;

    const handle: ProposalHandle = {
      branch,
      worktreeDir,
      agentDir: path.join(worktreeDir, config.agentSubdir),
    };

    const transcript = await fs
      .readFile(path.join(worktreeDir, transcriptRelFor(branch)), "utf8")
      .then((t) => JSON.parse(t) as Transcript)
      .catch(() => null);

    const p: StoredProposal = {
      id: idFor(branch),
      handle,
      incidentDescription:
        transcript?.incident ?? "(recovered from the branch — this proposal predates the on-branch transcript)",
      createdAt: transcript?.createdAt ?? new Date().toISOString(),
      turns: transcript?.turns ?? [],
      recovered: true,
      phase: "idle",
      phaseLabel: null,
      startedAt: null,
      // A proposal that was mid-run when the process died has no way to
      // resume that run; saying so is better than showing a spinner that
      // will never resolve.
      lastError: transcript
        ? null
        : "Recovered from git with no transcript on the branch. The branch, its commits and its diff survived; the conversation did not.",
      conflict: null,
      abort: null,
    };
    store.set(p.id, p);
  }
}
