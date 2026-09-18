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
const TRANSCRIPTS_DIR_REL = path.join(config.agentSubdir, "proposals");

const PRIMARY_DIR = path.join(config.runtimeDir, "primary");
const WORKTREES_DIR = path.join(config.runtimeDir, "worktrees");

let primaryGit: SimpleGit | null = null;

/** Set when a local commit landed but `git push` failed. Surfaced on
 *  /api/status so "merged here, not on origin" is a visible state
 *  rather than a 500 that loses the merge that already happened. */
let lastPushError: string | null = null;

export function getLastPushError(): string | null {
  return lastPushError;
}

/** Approving a proposal whose branch no longer applies cleanly to main.
 *  Carries the conflicting paths so the UI can name them. */
export class MergeConflictError extends Error {
  readonly paths: string[];
  constructor(paths: string[]) {
    super(`merge conflict in ${paths.join(", ") || "the ruleset"}`);
    this.name = "MergeConflictError";
    this.paths = paths;
  }
}

/** A rollback that git cannot express -- the root commit has no parent,
 *  or the ruleset did not exist before the commit being rolled back. */
export class NotRevertableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotRevertableError";
  }
}

// Every mutation against `main` (approve/reject/revert) goes through this
// queue so two analyst actions can't race on the same checkout. Creating
// a worktree is serialized here too: it doesn't touch main's working
// tree, but it does write refs and .git/worktrees metadata, and two
// concurrent proposals starting in the same tick is an ordinary thing
// for this UI to do. Reads don't need the lock.
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
  return (
    input
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "")
      .slice(0, 40) || "proposal"
  );
}

/** Filename the branch's transcript lives under, on the branch itself
 *  and (after a decision) on main. `proposal/foo-abc` -> `foo-abc.json`. */
export function transcriptRelFor(branch: string): string {
  return path.join(TRANSCRIPTS_DIR_REL, `${branch.replace(/^proposal\//, "").replace(/\//g, "__")}.json`);
}

/** Paths the server writes on the agent's branch on the agent's behalf.
 *  Excluded from the "agent touched files it shouldn't have" warning,
 *  because the agent didn't touch them -- we did. */
function isServerOwned(relPath: string): boolean {
  return relPath.split(path.sep).join("/").startsWith(TRANSCRIPTS_DIR_REL.split(path.sep).join("/") + "/");
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
  // Drops worktree metadata whose directory is gone (a container that
  // lost /tmp, an interrupted remove). Without this, `worktree list`
  // reports branches we can never check out again and recovery on boot
  // resurrects proposals that have no files behind them.
  await primaryGit.raw(["worktree", "prune"]).catch(() => undefined);
  return { mode: remote ? "remote" : "local-only" };
}

function git(): SimpleGit {
  if (!primaryGit) throw new Error("repoManager not initialized -- call initRepo() first");
  return primaryGit;
}

export function primaryDir(): string {
  return PRIMARY_DIR;
}

async function pushMain(): Promise<void> {
  if (!config.gitRepoUrl) return; // local-only mode, nothing to push
  try {
    await git().push("origin", "main");
    lastPushError = null;
  } catch (err) {
    // The commit is already on local main at this point. Throwing here
    // would report the whole approve as failed when the merge in fact
    // succeeded, so this records the failure for the status bar instead
    // of unwinding work that did happen.
    lastPushError = err instanceof Error ? err.message : String(err);
  }
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

const REC = "\x1e";
const FLD = "\x1f";

/**
 * The decision timeline. Keyed on the ruleset *and* the memory log,
 * because a rejection never touches the ruleset and is still a decision
 * that has to appear in the record -- otherwise the timeline silently
 * omits every proposal the analyst turned down.
 */
export async function getHistory(limit = 40): Promise<HistoryEntry[]> {
  const raw = await git().raw([
    "log",
    `--max-count=${limit}`,
    "--name-only",
    `--pretty=format:${REC}%H${FLD}%aI${FLD}%s${FLD}%an${FLD}%P${FLD}`,
    "--",
    RULESET_REL,
    MEMORY_REL,
  ]);

  const entries: HistoryEntry[] = [];
  for (const block of raw.split(REC)) {
    if (!block.trim()) continue;
    const [header, ...rest] = block.split("\n");
    const [sha, date, message, author, parents] = header.split(FLD);
    if (!sha) continue;
    const files = rest.map((l) => l.trim()).filter(Boolean);
    const norm = (p: string) => p.split(path.sep).join("/");
    const touchesRuleset = files.some((f) => f === norm(RULESET_REL));
    const touchesMemory = files.some((f) => f === norm(MEMORY_REL));
    const isRoot = !parents?.trim();
    entries.push({
      sha,
      shortSha: sha.slice(0, 7),
      date,
      message,
      author,
      isRoot,
      touchesRuleset,
      touchesMemory,
      kind: isRoot ? "seed" : touchesRuleset ? "change" : "decision",
      // A commit that didn't change the ruleset has no ruleset state to
      // restore, and the root commit has no parent at all. Both were
      // previously offered a "roll back" button that could only throw.
      canRevert: !isRoot && touchesRuleset,
    });
  }
  return entries;
}

export interface CommitDetail {
  rulesetDiff: string;
  memoryDiff: string;
}

export async function getCommitDiff(sha: string): Promise<CommitDetail> {
  const g = git();
  const [rulesetDiff, memoryDiff] = await Promise.all([
    g.show([sha, "--", RULESET_REL]).catch(() => ""),
    g.show([sha, "--", MEMORY_REL]).catch(() => ""),
  ]);
  return { rulesetDiff, memoryDiff };
}

export interface ProposalHandle {
  branch: string;
  worktreeDir: string;
  agentDir: string;
}

export async function createProposal(incidentDescription: string): Promise<ProposalHandle> {
  const branch = `proposal/${slugify(incidentDescription)}-${Date.now().toString(36)}`;
  const worktreeDir = path.join(WORKTREES_DIR, branch.replace(/\//g, "__"));
  await withMainLock(async () => {
    await git().raw(["worktree", "add", "-b", branch, worktreeDir, "main"]);
  });
  const wg = simpleGit(worktreeDir);
  await wg.addConfig("user.name", config.gitAuthorName);
  await wg.addConfig("user.email", config.gitAuthorEmail);
  return { branch, worktreeDir, agentDir: path.join(worktreeDir, config.agentSubdir) };
}

export interface CommitOutcome {
  unexpectedFileChanges: string[];
  /** The agent changed at least one file. */
  hadChanges: boolean;
  /** The agent changed the ruleset specifically. */
  rulesetChanged: boolean;
}

/**
 * Commits whatever the agent changed on its proposal branch, plus the
 * server-written transcript. Returns any *agent*-changed paths outside
 * the ruleset, so the caller can surface that to the analyst instead of
 * hiding it -- the transcript is excluded from that list because the
 * server wrote it, not the agent. The status read happens before the
 * transcript is written for exactly that reason.
 */
export async function commitProposalChanges(
  handle: ProposalHandle,
  commitMsg: string,
  extraFiles: Array<{ relPath: string; content: string }> = [],
): Promise<CommitOutcome> {
  const wg = simpleGit(handle.worktreeDir);
  const status = await wg.status();
  const changed = [...new Set([...status.modified, ...status.not_added, ...status.created])];

  const norm = (p: string) => p.split(path.sep).join("/");
  const agentChanged = changed.filter((f) => !isServerOwned(f));
  const unexpected = agentChanged.filter((f) => norm(f) !== norm(RULESET_REL));
  const rulesetChanged = agentChanged.some((f) => norm(f) === norm(RULESET_REL));

  for (const file of extraFiles) {
    const abs = path.join(handle.worktreeDir, file.relPath);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, file.content);
  }

  const after = await wg.status();
  const toAdd = [...new Set([...after.modified, ...after.not_added, ...after.created])];
  if (toAdd.length === 0) {
    return { unexpectedFileChanges: unexpected, hadChanges: false, rulesetChanged: false };
  }

  await wg.add(toAdd);
  await wg.commit(commitMsg);
  return { unexpectedFileChanges: unexpected, hadChanges: agentChanged.length > 0, rulesetChanged };
}

export async function diffProposalAgainstMain(handle: ProposalHandle): Promise<string> {
  const wg = simpleGit(handle.worktreeDir);
  // `main...HEAD` diffs against the merge base, so a branch that is
  // merely behind main still shows only its own change rather than
  // everything main gained in the meantime.
  return wg.diff(["main...HEAD", "--", RULESET_REL]).catch(() => "");
}

/** Commits on main that this branch doesn't have. Non-zero means main
 *  moved under the proposal and approving it may not apply cleanly. */
export async function commitsBehindMain(handle: ProposalHandle): Promise<number> {
  try {
    const out = await simpleGit(handle.worktreeDir).raw(["rev-list", "--count", "HEAD..main"]);
    return Number(out.trim()) || 0;
  } catch {
    return 0;
  }
}

export async function readTranscript(handle: ProposalHandle): Promise<string | null> {
  const rel = transcriptRelFor(handle.branch);
  return fs.readFile(path.join(handle.worktreeDir, rel), "utf8").catch(() => null);
}

async function appendMemory(dir: string, entry: string): Promise<void> {
  const memPath = path.join(dir, MEMORY_REL);
  const existing = await fs.readFile(memPath, "utf8").catch(() => "");
  await fs.writeFile(memPath, existing.replace(/\s+$/, "") + "\n\n" + entry.trim() + "\n");
}

/** Puts main back to a clean checkout after a failed merge. A squash
 *  merge writes no MERGE_HEAD, so `git merge --abort` is not available
 *  and a hard reset is the correct unwind. Worktrees live outside
 *  PRIMARY_DIR, so `clean -fd` here can't reach a proposal's files. */
async function restoreMain(): Promise<void> {
  const g = git();
  await g.raw(["merge", "--abort"]).catch(() => undefined);
  await g.raw(["reset", "--hard", "HEAD"]).catch(() => undefined);
  await g.raw(["clean", "-fd"]).catch(() => undefined);
}

export async function approveProposal(
  handle: ProposalHandle,
  commitMsg: string,
  analystNote: string,
): Promise<void> {
  await withMainLock(async () => {
    const g = git();
    await g.checkout("main");

    // `git merge --squash` reports a conflict by leaving unmerged entries
    // in the index and exiting non-zero -- but simple-git's `raw` RESOLVES
    // on that exit code rather than rejecting, so a try/catch around the
    // merge sees success and commits conflict markers straight into the
    // live ruleset. The index is the authority here, not the exception.
    let mergeError: unknown = null;
    try {
      await g.raw(["merge", "--squash", handle.branch]);
    } catch (err) {
      mergeError = err;
    }
    const conflicted = await g
      .raw(["diff", "--name-only", "--diff-filter=U"])
      .then((out) => out.split("\n").map((l) => l.trim()).filter(Boolean))
      .catch(() => [] as string[]);
    if (conflicted.length) {
      await restoreMain();
      throw new MergeConflictError(conflicted);
    }
    if (mergeError) {
      await restoreMain();
      throw mergeError;
    }

    const ts = new Date().toISOString();
    const memEntry = `### ${ts} — approved — ${commitMsg}\nAnalyst note: ${analystNote || "(none provided)"}`;
    await appendMemory(PRIMARY_DIR, memEntry);

    // The transcript came across with the squash merge; stamp the
    // decision onto it so the archived record on main says how it ended
    // rather than freezing at "open".
    const transcriptRel = transcriptRelFor(handle.branch);
    await stampTranscript(path.join(PRIMARY_DIR, transcriptRel), "approved", analystNote, ts);

    await g.add([RULESET_REL, MEMORY_REL]);
    await g.add([transcriptRel]).catch(() => undefined);
    // A squash merge with no net ruleset change (e.g. an approved
    // no-op iteration) can leave nothing staged for the ruleset path --
    // that's fine, the memory entry alone is still a real commit.
    await g.commit(commitMsg || "Approve proposal");
    await pushMain();

    await removeProposal(handle);
  });
}

async function stampTranscript(
  absPath: string,
  status: "approved" | "rejected",
  analystNote: string,
  at: string,
): Promise<void> {
  const raw = await fs.readFile(absPath, "utf8").catch(() => null);
  if (!raw) return;
  try {
    const doc = JSON.parse(raw);
    doc.status = status;
    doc.decidedAt = at;
    doc.analystNote = analystNote || null;
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    await fs.writeFile(absPath, JSON.stringify(doc, null, 2) + "\n");
  } catch {
    /* a transcript we can't parse is not worth failing a merge over */
  }
}

/**
 * Rejection deletes the branch but keeps the record: the memory entry
 * says what was turned down and why, and the conversation that produced
 * it is archived onto main alongside it. Without that second half, the
 * agent can read "we rejected X" but never *what* X argued.
 */
export async function rejectProposal(handle: ProposalHandle, analystNote: string): Promise<void> {
  const transcript = await readTranscript(handle);
  await withMainLock(async () => {
    const g = git();
    await g.checkout("main");
    const ts = new Date().toISOString();
    const memEntry = `### ${ts} — rejected — proposal on \`${handle.branch}\` discarded\nAnalyst note: ${analystNote || "(none provided)"}`;
    await appendMemory(PRIMARY_DIR, memEntry);

    const paths = [MEMORY_REL];
    if (transcript) {
      const transcriptRel = transcriptRelFor(handle.branch);
      const abs = path.join(PRIMARY_DIR, transcriptRel);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, transcript);
      await stampTranscript(abs, "rejected", analystNote, ts);
      paths.push(transcriptRel);
    }

    await g.add(paths);
    await g.commit(`Record rejected proposal: ${handle.branch}`);
    await pushMain();

    await removeProposal(handle);
  });
}

export async function discardProposal(handle: ProposalHandle): Promise<void> {
  await withMainLock(() => removeProposal(handle));
}

async function removeProposal(handle: ProposalHandle): Promise<void> {
  const g = git();
  await g.raw(["worktree", "remove", "--force", handle.worktreeDir]).catch(() => undefined);
  await g.raw(["branch", "-D", handle.branch]).catch(() => undefined);
  await g.raw(["worktree", "prune"]).catch(() => undefined);
}

/**
 * Rollback as a forward commit: the prior file content is written as a
 * new commit, so both the bad rule and the decision to pull it survive
 * in the log. Never a history rewrite.
 */
export async function revertToParentOf(sha: string, analystNote: string): Promise<void> {
  await withMainLock(async () => {
    const g = git();
    await g.checkout("main");

    const parents = await g
      .raw(["rev-list", "--parents", "-n", "1", sha])
      .then((s) => s.trim().split(/\s+/).slice(1))
      .catch(() => [] as string[]);
    if (parents.length === 0) {
      // The repository's own root commit. There is no earlier state to
      // restore, and `sha^` would simply throw. The UI hides the button
      // for these; this is the server-side half of the same guard.
      throw new NotRevertableError(
        `${sha.slice(0, 7)} is the repository's first commit — there is no earlier ruleset to roll back to.`,
      );
    }

    const priorContent = await g.show([`${sha}^:${RULESET_REL}`]).catch(() => null);
    if (priorContent === null) {
      throw new NotRevertableError(
        `The ruleset did not exist before ${sha.slice(0, 7)}, so there is no prior version to restore.`,
      );
    }

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
