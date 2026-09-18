#!/usr/bin/env node
// Exercises the full git-native lifecycle WITHOUT calling any LLM:
// propose -> edit -> commit -> diff -> approve (squash-merge + memory) ->
// history -> revert, plus the paths that used to be assumed rather than
// tested: two concurrent proposals, a merge conflict on approval, a
// rejection, recovery of an open proposal after a "restart", and the
// rollback guards on commits that have nothing to roll back to.
//
// This is the test that proves the git mechanics are real, independent
// of whether a model provider is reachable.
//
// Run: node scripts/lifecycle-test.mjs

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const RUNTIME = path.join(os.tmpdir(), "rd-lifecycle");
process.env.RUNTIME_DIR = RUNTIME;
process.env.PORT = "0";

await fs.rm(RUNTIME, { recursive: true, force: true });

const repo = await import("../server/dist/repoManager.js");
const store = await import("../server/dist/proposalStore.js");

let failures = 0;
let checks = 0;

function ok(label, cond, detail = "") {
  checks += 1;
  if (cond) {
    console.log(`   ✓ ${label}`);
  } else {
    failures += 1;
    console.log(`   ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function step(n, label) {
  console.log(`\n${n}. ${label}`);
}

const RULESET_REL = path.join("agent", "rules", "active-ruleset.yaml");

/** Plain git, so this script needs nothing installed under scripts/. */
async function git(...args) {
  const { stdout } = await execFileAsync("git", ["-C", repo.primaryDir(), ...args]);
  return stdout.trim();
}

/** Stands in for what the agent's `write` tool does on its branch. */
async function editThreshold(handle, from, to) {
  const rulePath = path.join(handle.worktreeDir, RULESET_REL);
  const before = await fs.readFile(rulePath, "utf8");
  if (!before.includes(from)) throw new Error(`fixture drift: "${from}" not in the ruleset`);
  await fs.writeFile(rulePath, before.replace(from, to));
}

// ---------------------------------------------------------------- 1
step(1, "init repo");
const { mode } = await repo.initRepo();
ok("runs in local-only mode with no GIT_REPO_URL", mode === "local-only", mode);

// ---------------------------------------------------------------- 2
step(2, "read the live ruleset on main");
const before = await repo.getLiveRulesetText();
const ruleIds = repo.parseRuleSummaries(before).map((r) => r.id);
ok("parses every rule out of the hand-written YAML", ruleIds.length === 3, ruleIds.join(", "));
ok("ruleset carries a version", /^version:\s*\d+/m.test(before));

// ---------------------------------------------------------------- 3
step(3, "open two concurrent proposals");
const [a, b] = await Promise.all([
  repo.createProposal("chargebacks under 50k from new devices"),
  repo.createProposal("geo mismatch too noisy for travellers"),
]);
ok("both get their own proposal/* branch", a.branch !== b.branch && a.branch.startsWith("proposal/"));
ok("both get their own worktree", a.worktreeDir !== b.worktreeDir);
const mainHead = await git("rev-parse", "--abbrev-ref", "HEAD");
ok("main is still checked out on main", mainHead === "main", mainHead);

// ---------------------------------------------------------------- 4
step(4, "agent edits one threshold on branch A, server commits it with a transcript");
await editThreshold(a, "amount_threshold_inr: 50000", "amount_threshold_inr: 25000");
const pA = store.create(a, "chargebacks under 50k from new devices");
store.addTurn(pA.id, {
  role: "agent",
  text: "Lowering the new-device velocity threshold. Catch rate +6.9pp, false positives +1.2pp.",
  at: new Date().toISOString(),
  commitMsg: "Lower new-device velocity threshold to 25,000",
});
const outA = await repo.commitProposalChanges(a, "Lower new-device velocity threshold to 25,000", [
  store.transcriptFor(pA),
]);
ok("commit reports the ruleset as changed", outA.rulesetChanged && outA.hadChanges);
ok("nothing outside the ruleset is blamed on the agent", outA.unexpectedFileChanges.length === 0, outA.unexpectedFileChanges.join(", "));

// ---------------------------------------------------------------- 5
step(5, "a one-line rule change stays a one-line diff");
const diffA = await repo.diffProposalAgainstMain(a);
const added = diffA.split("\n").filter((l) => /^\+[^+]/.test(l));
const removed = diffA.split("\n").filter((l) => /^-[^-]/.test(l));
console.log(`   ${removed.join("\n   ")}\n   ${added.join("\n   ")}`);
// The reason repoManager and backtest.mjs hand-roll their YAML handling
// instead of round-tripping js-yaml: a parse/dump reformats the whole
// file and turns this into a 40-line diff. If that ever regresses, this
// assertion is what catches it.
ok("exactly one line added and one removed", added.length === 1 && removed.length === 1, `+${added.length}/-${removed.length}`);
ok("comments and untouched formatting survive", (await fs.readFile(path.join(a.worktreeDir, RULESET_REL), "utf8")).startsWith("# Live transaction-monitoring ruleset."));

// ---------------------------------------------------------------- 6
step(6, "an open proposal survives a server restart, conversation included");
const freshStore = await import("../server/dist/proposalStore.js?restart=1");
ok("a fresh process starts with an empty store", freshStore.list().length === 0);
await freshStore.reconcileFromGit(repo.primaryDir());
const recovered = freshStore.list();
ok("both open proposals are picked back up from their worktrees", recovered.length === 2, String(recovered.length));
const recoveredA = recovered.find((p) => p.handle.branch === a.branch);
ok("the committed transcript restores the incident text", recoveredA?.incidentDescription === "chargebacks under 50k from new devices");
ok("the committed transcript restores the conversation", recoveredA?.turns.length === 1, String(recoveredA?.turns.length));
ok("recovered proposals are flagged as recovered", recoveredA?.recovered === true);

// ---------------------------------------------------------------- 7
step(7, "approve A: squash-merge into main + memory entry in the same commit");
await repo.approveProposal(a, "Lower new-device velocity threshold to 25,000", "Approved after incident review.");
const afterApprove = await repo.getLiveRulesetText();
ok("the live ruleset on main now carries the change", afterApprove.includes("amount_threshold_inr: 25000"));
const memAfter = await fs.readFile(path.join(repo.primaryDir(), "agent", "memory", "MEMORY.md"), "utf8");
ok("MEMORY.md records the approval", memAfter.includes("approved — Lower new-device velocity threshold"));
ok("the analyst's reasoning is in the memory entry", memAfter.includes("Approved after incident review."));
const archived = await fs
  .readFile(path.join(repo.primaryDir(), "agent", "proposals", `${a.branch.replace("proposal/", "")}.json`), "utf8")
  .then(JSON.parse)
  .catch(() => null);
ok("the conversation is archived on main beside the change", archived?.status === "approved", JSON.stringify(archived?.status));

// ---------------------------------------------------------------- 8
step(8, "approving B now conflicts — main moved under it");
await editThreshold(b, "amount_threshold_inr: 50000", "amount_threshold_inr: 40000");
const pB = store.create(b, "geo mismatch too noisy for travellers");
store.addTurn(pB.id, { role: "agent", text: "Raising the velocity amount instead.", at: new Date().toISOString() });
await repo.commitProposalChanges(b, "Raise new-device velocity threshold to 40,000", [store.transcriptFor(pB)]);
ok("B reports itself behind main", (await repo.commitsBehindMain(b)) > 0);
let conflict = null;
try {
  await repo.approveProposal(b, "Raise new-device velocity threshold to 40,000", "");
} catch (err) {
  conflict = err;
}
ok("the conflict is a typed error, not a raw git failure", conflict?.name === "MergeConflictError", conflict?.name);
ok("the conflicting path is named", conflict?.paths?.some((p) => p.includes("active-ruleset")), JSON.stringify(conflict?.paths));
const statusAfterConflict = await git("status", "--porcelain");
ok("main is left clean — the failed merge was unwound", statusAfterConflict === "", statusAfterConflict);
ok("main still has the approved ruleset", (await repo.getLiveRulesetText()).includes("amount_threshold_inr: 25000"));

// ---------------------------------------------------------------- 9
step(9, "reject B: branch is deleted, the decision is not");
await repo.rejectProposal(b, "Superseded by the merge that just landed.");
const memAfterReject = await fs.readFile(path.join(repo.primaryDir(), "agent", "memory", "MEMORY.md"), "utf8");
ok("MEMORY.md records the rejection", memAfterReject.includes("rejected"));
ok("the rejection reason is recorded for the agent to read", memAfterReject.includes("Superseded by the merge"));
const rejectedArchive = await fs
  .readFile(path.join(repo.primaryDir(), "agent", "proposals", `${b.branch.replace("proposal/", "")}.json`), "utf8")
  .then(JSON.parse)
  .catch(() => null);
ok("the rejected conversation is archived too", rejectedArchive?.status === "rejected", JSON.stringify(rejectedArchive?.status));
const branches = await git("branch", "--list", "proposal/*");
ok("the rejected branch is gone", !branches.includes(b.branch), branches);

// --------------------------------------------------------------- 10
step(10, "history covers changes and decisions");
const history = await repo.getHistory();
history.forEach((h) => console.log(`   ${h.shortSha}  ${h.kind.padEnd(8)} ${h.message}`));
ok("rejections appear in the timeline, not just merges", history.some((h) => h.kind === "decision"));
ok("the merge appears as a ruleset change", history.some((h) => h.kind === "change" && h.touchesRuleset));

// --------------------------------------------------------------- 11
step(11, "rollback guards");
const root = history[history.length - 1];
ok("the root commit is marked as not rollback-able", root.isRoot && root.canRevert === false, JSON.stringify({ isRoot: root.isRoot, canRevert: root.canRevert }));
let rootErr = null;
try {
  await repo.revertToParentOf(root.sha, "should not be possible");
} catch (err) {
  rootErr = err;
}
// This used to be a raw `git show <root>^` failure surfaced as a 500.
ok("rolling back the root commit is refused with a real reason", rootErr?.name === "NotRevertableError", rootErr?.name);
const decision = history.find((h) => h.kind === "decision");
ok("a memory-only decision commit is marked as not rollback-able", decision && decision.canRevert === false);

// --------------------------------------------------------------- 12
step(12, "revert the approved change — a forward commit, never a rewrite");
const change = history.find((h) => h.kind === "change" && h.canRevert);
const shaBefore = await git("rev-parse", "HEAD");
await repo.revertToParentOf(change.sha, "False-positive spike in the review queue.");
const reverted = await repo.getLiveRulesetText();
ok("the live ruleset is back to its previous state", reverted.includes("amount_threshold_inr: 50000"));
const finalHistory = await repo.getHistory();
ok("the reverted commit is still in the log", finalHistory.some((h) => h.sha === change.sha));
ok("the revert is a new commit on top", finalHistory[0].sha !== shaBefore && finalHistory[0].message.startsWith("Revert ruleset"));
finalHistory.forEach((h) => console.log(`   ${h.shortSha}  ${h.kind.padEnd(8)} ${h.message}`));

// --------------------------------------------------------------- 13
step(13, "the agent never reached main");
const mainLog = await git("log", "--format=%an <%ae>", "-n", "50");
console.log(`   authors on main: ${[...new Set(mainLog.split("\n"))].join(", ")}`);
const leftover = await git("branch", "--list", "proposal/*");
ok("no proposal branch is left behind", leftover === "", leftover);

console.log(`\n${failures === 0 ? "LIFECYCLE TEST PASSED" : "LIFECYCLE TEST FAILED"} — ${checks - failures}/${checks} checks`);
process.exit(failures === 0 ? 0 : 1);
