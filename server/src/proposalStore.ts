import { simpleGit } from "simple-git";
import path from "node:path";
import { config } from "./config.js";
import type { ProposalHandle } from "./repoManager.js";
import type { ProposalTurn } from "./types.js";

interface StoredProposal {
  id: string;
  handle: ProposalHandle;
  incidentDescription: string;
  createdAt: string;
  turns: ProposalTurn[];
  recovered?: boolean;
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
  };
  store.set(p.id, p);
  return p;
}

export function get(id: string): StoredProposal | undefined {
  return store.get(id);
}

export function list(): StoredProposal[] {
  return [...store.values()];
}

export function remove(id: string): void {
  store.delete(id);
}

export function addTurn(id: string, turn: ProposalTurn): void {
  const p = store.get(id);
  if (p) p.turns.push(turn);
}

/**
 * On boot, picks up any `proposal/*` worktrees left over from a
 * previous server process (e.g. a Render restart) so they're at least
 * visible and actionable again. The conversational turn history for
 * those lived only in server memory and is genuinely gone -- this
 * recovers the git-native state (branch, diff, commits), not the
 * chat transcript. See NOTES.md.
 */
export async function reconcileFromGit(primaryDir: string): Promise<void> {
  const g = simpleGit(primaryDir);
  const raw = await g.raw(["worktree", "list", "--porcelain"]).catch(() => "");
  const blocks = raw.split(/\n\n+/).filter(Boolean);
  for (const block of blocks) {
    const dirLine = block.match(/^worktree (.+)$/m);
    const branchLine = block.match(/^branch refs\/heads\/(.+)$/m);
    if (!dirLine || !branchLine) continue;
    const branch = branchLine[1];
    if (!branch.startsWith("proposal/")) continue;
    const worktreeDir = dirLine[1];
    const handle: ProposalHandle = {
      branch,
      worktreeDir,
      agentDir: path.join(worktreeDir, config.agentSubdir),
    };
    const p: StoredProposal = {
      id: idFor(branch),
      handle,
      incidentDescription: "(recovered after restart -- original request text not preserved)",
      createdAt: new Date().toISOString(),
      turns: [],
      recovered: true,
    };
    store.set(p.id, p);
  }
}
