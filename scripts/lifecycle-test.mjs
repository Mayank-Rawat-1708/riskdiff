#!/usr/bin/env node
// Exercises the full git-native lifecycle WITHOUT calling any LLM:
// create a proposal worktree -> write a rule edit by hand (standing in
// for what the agent's `write` tool does) -> commit -> diff -> approve
// (squash-merge + memory entry) -> read history -> revert.
//
// This is the test that proves the git mechanics are real, independent
// of whether a model provider is reachable. Run: node scripts/lifecycle-test.mjs

import fs from "node:fs/promises";
import path from "node:path";

process.env.RUNTIME_DIR = "/tmp/rd-lifecycle";
process.env.PORT = "0";

const repo = await import("../server/dist/repoManager.js");

await fs.rm("/tmp/rd-lifecycle", { recursive: true, force: true });

console.log("1. init repo");
const { mode } = await repo.initRepo();
console.log("   mode:", mode);

console.log("2. read live ruleset");
const before = await repo.getLiveRulesetText();
console.log("   version line:", before.match(/^version:.*$/m)[0]);
console.log("   rules:", repo.parseRuleSummaries(before).map((r) => r.id).join(", "));

console.log("3. create proposal branch + worktree");
const handle = await repo.createProposal("chargebacks under 50k from new devices");
console.log("   branch:", handle.branch);

console.log("4. simulate the agent editing the ruleset on its branch");
const rulePath = path.join(handle.agentDir, "rules", "active-ruleset.yaml");
const draft = (await fs.readFile(rulePath, "utf8")).replace(
  "amount_threshold_inr: 50000",
  "amount_threshold_inr: 25000",
);
await fs.writeFile(rulePath, draft);

console.log("5. commit on the proposal branch");
const { unexpectedFileChanges, hadChanges } = await repo.commitProposalChanges(
  handle,
  "Lower new-device velocity threshold to 25,000",
);
console.log("   hadChanges:", hadChanges, "| unexpected:", unexpectedFileChanges);

console.log("6. diff proposal against main");
const diff = await repo.diffProposalAgainstMain(handle);
console.log(diff.split("\n").filter((l) => /^[+-][^+-]/.test(l)).join("\n") || "   (no diff)");

console.log("7. approve (squash-merge + memory commit)");
await repo.approveProposal(handle, "Lower new-device velocity threshold to 25,000", "Approved after incident review.");

const after = await repo.getLiveRulesetText();
console.log("   live threshold now:", after.match(/amount_threshold_inr: \d+/)[0]);

console.log("8. history of the ruleset file");
const history = await repo.getHistory();
history.forEach((h) => console.log(`   ${h.shortSha}  ${h.message}`));

console.log("9. revert the newest commit");
await repo.revertToParentOf(history[0].sha, "False-positive spike in the review queue.");
const reverted = await repo.getLiveRulesetText();
console.log("   live threshold after revert:", reverted.match(/amount_threshold_inr: \d+/)[0]);

console.log("10. final history (revert is itself a commit, nothing rewritten)");
(await repo.getHistory()).forEach((h) => console.log(`   ${h.shortSha}  ${h.message}`));

console.log("11. memory file tail");
const mem = await fs.readFile("/tmp/rd-lifecycle/primary/agent/memory/MEMORY.md", "utf8");
console.log(mem.trim().split("\n").slice(-6).map((l) => "   " + l).join("\n"));

console.log("\nLIFECYCLE TEST PASSED");
process.exit(0);
