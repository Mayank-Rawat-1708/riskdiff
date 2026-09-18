import { simpleGit, type SimpleGit } from "simple-git";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import type { HistoryEntry, RuleSummary } from "./types.js";

// Repo root as shipped (…/riskdiff), computed from this compiled
// file's own location rather than process.cwd() -- cwd at start
// depends on how the process was launched (npm script dir, Render's
// working directory setting, etc.) and shouldn't be load-bearing.
const SHIPPED_REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const RULESET_REL = path.join(config.agentSubdir, "rules", "active-ruleset.yaml");
const MEMORY_REL = path.join(config.agentSubdir, "memory", "MEMORY.md");

const PRIMARY_DIR = path.join(config.runtimeDir, "primary");
const WORKTREES_DIR = path.join(config.runtimeDir, "worktrees");

let primaryGit: SimpleGit | null = null;

// Every mutation against `main` (approve/reject/revert) goes through this
// queue so two analyst actions can't race on the same checkout. Reads
// don't need it -- git's working tree is only ever touched by writers.
let mainLock: Promise<unknown> = Promise.resolve();
function withMainLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = mainLock.then(fn, fn);
  mainLock = run.catch(() => undefined);
  return run;
}

function authedRemote(): string | null {
  if (!config.gitRepoUrl) return null;
  if (!config.githubPat) return config.gitRepoUrl;
  // Embeds the PAT in the remote URL for push access. Simplest thing
  // that works for a take-home; a real deployment would use a
  // credential helper or a GitHub App token instead of a URL-embedded
  // PAT sitting in .git/config on disk. See NOTES.md.
  const url = new URL(config.gitRepoUrl);
  url.username = "x-access-token";
  url.password = config.githubPat;
  return url.toString();
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 40) || "proposal";
}

export async function initRepo(): Promise<{ mode: "remote" | "local-only" }> {
  await fs.mkdir(config.runtimeDir, { recursive: true });
  const remote = authedRemote();

  const exists = await fs
    .access(path.join(PRIMARY_DIR, ".git"))
    .then(() => true)
    .catch(() => false);

  if (!exists) {
    if (remote) {
      await simpleGit().clone(remote, PRIMARY_DIR);
    } else {
      // Local-only fallback: no GIT_REPO_URL configured yet. Seeds the
      // runtime repo from the agent/ directory shipped in this same
      // deploy so the workbench is fully usable before you've wired up
      // a GitHub repo -- nothing pushes anywhere in this mode.
      await fs.mkdir(PRIMARY_DIR, { recursive: true });
      const seedAgentDir = path.join(SHIPPED_REPO_ROOT, config.agentSubdir);
      await fs.cp(seedAgentDir, path.join(PRIMARY_DIR, config.agentSubdir), { recursive: true });
      const g = simpleGit(PRIMARY_DIR);
      await g.init(["-b", "main"]);
      await g.addConfig("user.name", config.gitAuthorName);
      await g.addConfig("user.email", config.gitAuthorEmail);
      await g.add(".");
      await g.commit("Seed local-only runtime repo (no GIT_REPO_URL configured)");
    }
  }

  primaryGit = simpleGit(PRIMARY_DIR);
  await primaryGit.addConfig("user.name", config.gitAuthorName);
  await primaryGit.addConfig("user.email", config.gitAuthorEmail);

  if (remote) {
    await primaryGit.fetch("origin");
    await primaryGit.checkout("main");
    await primaryGit.reset(["--hard", "origin/main"]);
  }

  await fs.mkdir(WORKTREES_DIR, { recursive: true });
  return { mode: remote ? "remote" : "local-only" };
}

function git(): SimpleGit {
  if (!primaryGit) throw new Error("repoManager not initialized -- call initRepo() first");
  return primaryGit;
}

async function pushMain(): Promise<void> {
  if (!config.gitRepoUrl) return; // local-only mode, nothing to push
  await git().push("origin", "main");
}

export async function getLiveRulesetText(): Promise<string> {
  return fs.readFile(path.join(PRIMARY_DIR, RULESET_REL), "utf8");
}

export function parseRuleSummaries(yamlText: string): RuleSummary[] {
  const rules: RuleSummary[] = [];
  let current: Partial<RuleSummary> | null = null;
  let inCondition = false;
  // When a `description: >` folded block opens, subsequent deeper-indented
  // lines belong to it until a key at the rule's own level appears.
  let foldingInto: "description" | null = null;
  let foldBaseIndent = 0;
  let conditionIndent = 0;

  const lines = yamlText.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.replace(/#.*$/, "");
    if (!line.trim()) continue;
    const indent = line.match(/^\s*/)![0].length;

    const idMatch = line.match(/^\s*-\s+id:\s*(.+)$/);
    if (idMatch) {
      if (current?.id) rules.push(current as RuleSummary);
      current = { id: idMatch[1].trim(), description: "" };
      inCondition = false;
      foldingInto = null;
      continue;
    }
    if (!current) continue;

    if (foldingInto && indent > foldBaseIndent) {
      current.description = `${current.description ?? ""} ${line.trim()}`.trim();
      continue;
    }
    foldingInto = null;

    if (/^\s*condition:\s*$/.test(line)) {
      inCondition = true;
      conditionIndent = indent;
      continue;
    }

    const kv = line.match(/^\s*([a-zA-Z_]+):\s*(.*)$/);
    if (!kv) continue;
    const [, key, val] = kv;

    // Indentation, not key order, is what says whether we're still
    // inside the nested `condition:` map. Rule-level keys (description,
    // action, severity) sit at 4 spaces; condition's own keys at 6.
    if (inCondition && indent <= conditionIndent) inCondition = false;

    if (key === "description") {
      inCondition = false;
      const v = val.trim();
      if (v === ">" || v === ">-" || v === "|" || v === "|-") {
        foldingInto = "description";
        foldBaseIndent = indent;
        current.description = "";
      } else {
        current.description = v;
      }
    } else if (!inCondition && key === "severity") {
      current.severity = val.trim();
    } else if (!inCondition && key === "action") {
      current.action = val.trim();
    }
  }
  if (current?.id) rules.push(current as RuleSummary);
  return rules;
}

export async function getHistory(limit = 30): Promise<HistoryEntry[]> {
  const log = await git().log({
    file: RULESET_REL,
    maxCount: limit,
    format: { hash: "%H", date: "%aI", message: "%s", author: "%an" },
  });
  return log.all.map((c) => ({
    sha: c.hash,
    shortSha: c.hash.slice(0, 7),
    date: c.date,
    message: c.message,
    author: c.author,
  }));
}

export async function getCommitDiff(sha: string): Promise<string> {
  return git().show([`${sha}`, "--", RULESET_REL]);
}

export interface ProposalHandle {
  branch: string;
  worktreeDir: string;
  agentDir: string;
}

export async function createProposal(incidentDescription: string): Promise<ProposalHandle> {
  const branch = `proposal/${slugify(incidentDescription)}-${Date.now().toString(36)}`;
  const worktreeDir = path.join(WORKTREES_DIR, branch.replace(/\//g, "__"));
  await git().raw(["worktree", "add", "-b", branch, worktreeDir, "main"]);
  const wg = simpleGit(worktreeDir);
  await wg.addConfig("user.name", config.gitAuthorName);
  await wg.addConfig("user.email", config.gitAuthorEmail);
  return { branch, worktreeDir, agentDir: path.join(worktreeDir, config.agentSubdir) };
}

/** Commits whatever the agent changed on its proposal branch. Returns
 *  any changed paths outside the ruleset file, so the caller can
 *  surface that to the analyst instead of hiding it. */
export async function commitProposalChanges(
  handle: ProposalHandle,
  commitMsg: string,
): Promise<{ unexpectedFileChanges: string[]; hadChanges: boolean }> {
  const wg = simpleGit(handle.worktreeDir);
  const status = await wg.status();
  const changed = [...status.modified, ...status.not_added, ...status.created];
  if (changed.length === 0) return { unexpectedFileChanges: [], hadChanges: false };

  const rulesetRelFromWorktree = RULESET_REL;
  const unexpected = changed.filter((f) => f !== rulesetRelFromWorktree);

  await wg.add(changed);
  await wg.commit(commitMsg);
  return { unexpectedFileChanges: unexpected, hadChanges: true };
}

export async function diffProposalAgainstMain(handle: ProposalHandle): Promise<string> {
  const wg = simpleGit(handle.worktreeDir);
  return wg.diff(["main...HEAD", "--", RULESET_REL]);
}

async function appendMemory(dir: string, entry: string): Promise<void> {
  const memPath = path.join(dir, MEMORY_REL);
  const existing = await fs.readFile(memPath, "utf8").catch(() => "");
  await fs.writeFile(memPath, existing.replace(/\s+$/, "") + "\n\n" + entry.trim() + "\n");
}

export async function approveProposal(
  handle: ProposalHandle,
  commitMsg: string,
  analystNote: string,
): Promise<void> {
  await withMainLock(async () => {
    const g = git();
    await g.checkout("main");
    await g.raw(["merge", "--squash", handle.branch]);

    const ts = new Date().toISOString();
    const memEntry = `### ${ts} — approved — ${commitMsg}\nAnalyst note: ${analystNote || "(none provided)"}`;
    await appendMemory(PRIMARY_DIR, memEntry);
    await g.add([RULESET_REL, MEMORY_REL]);
    // A squash merge with no net ruleset change (e.g. an approved
    // no-op iteration) can leave nothing staged for the ruleset path --
    // that's fine, the memory entry alone is still a real commit.
    await g.commit(commitMsg || "Approve proposal");
    await pushMain();

    await removeProposal(handle);
  });
}

export async function rejectProposal(handle: ProposalHandle, analystNote: string): Promise<void> {
  await withMainLock(async () => {
    const g = git();
    await g.checkout("main");
    const ts = new Date().toISOString();
    const memEntry = `### ${ts} — rejected — proposal on \`${handle.branch}\` discarded\nAnalyst note: ${analystNote || "(none provided)"}`;
    await appendMemory(PRIMARY_DIR, memEntry);
    await g.add([MEMORY_REL]);
    await g.commit(`Record rejected proposal: ${handle.branch}`);
    await pushMain();

    await removeProposal(handle);
  });
}

async function removeProposal(handle: ProposalHandle): Promise<void> {
  const g = git();
  await g.raw(["worktree", "remove", "--force", handle.worktreeDir]).catch(() => undefined);
  await g.raw(["branch", "-D", handle.branch]).catch(() => undefined);
}

export async function revertToParentOf(sha: string, analystNote: string): Promise<void> {
  await withMainLock(async () => {
    const g = git();
    await g.checkout("main");
    const priorContent = await g.show([`${sha}^:${RULESET_REL}`]);
    await fs.writeFile(path.join(PRIMARY_DIR, RULESET_REL), priorContent);

    const subject = await g.show([sha, "--no-patch", "--format=%s"]).then((s) => s.trim());
    const ts = new Date().toISOString();
    const memEntry = `### ${ts} — reverted — restored ruleset to the state before \`${sha.slice(0, 7)}\` ("${subject}")\nAnalyst note: ${analystNote || "(none provided)"}`;
    await appendMemory(PRIMARY_DIR, memEntry);

    await g.add([RULESET_REL, MEMORY_REL]);
    await g.commit(`Revert ruleset to pre-${sha.slice(0, 7)} state`);
    await pushMain();
  });
}

export function repoMode(): "remote" | "local-only" {
  return config.gitRepoUrl ? "remote" : "local-only";
}
