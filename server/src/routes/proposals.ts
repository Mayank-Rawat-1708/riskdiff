import { Router } from "express";
import {
  createProposal,
  commitProposalChanges,
  diffProposalAgainstMain,
  commitsBehindMain,
  approveProposal,
  rejectProposal,
  discardProposal,
  MergeConflictError,
} from "../repoManager.js";
import { runAgentTurn, AgentCancelledError, AllProvidersFailedError } from "../agentRunner.js";
import { buildModelChain } from "../config.js";
import * as store from "../proposalStore.js";
import type { ProposalTurn, ProposalView } from "../types.js";

export const proposalsRouter = Router();

const INITIAL_INSTRUCTIONS = `An analyst on the transaction risk team reported the pattern below. Read
rules/active-ruleset.yaml and the last several entries of memory/MEMORY.md
yourself (you have read access), then follow the risk-policy-drafting
skill: restate the pattern in one sentence, check memory for anything
related, decide on exactly one rule change, call the backtest tool with the FULL
candidate rule list (every rule, not just the one you changed), then
write the tool's patched_yaml output verbatim into
rules/active-ruleset.yaml with the write tool. Do not hand-format the
YAML: patched_yaml is the live file with only your change applied, so
the analyst reviews a two-line diff instead of a rewritten file.
Report catch-rate / false-positive-rate deltas plus your honest
recommendation. End with a COMMIT_MSG line as RULES.md requires.

Analyst report:
"""
{{INPUT}}
"""`;

const ITERATE_INSTRUCTIONS = `The analyst reviewed your last proposal and has feedback. Your previous
response was:
"""
{{PREVIOUS}}
"""

Analyst feedback:
"""
{{INPUT}}
"""

Do all of the following, in this order. A revision that stops before
step 3 is not a revision — the analyst sees the same diff they already
rejected, and the workbench will tell them you changed nothing.

1. Read rules/active-ruleset.yaml on this branch. It already contains
   your previous change, so the numbers in it are your starting point,
   not the original ones.
2. Call the backtest tool with the full revised rule list.
3. Write the tool's patched_yaml output verbatim to
   rules/active-ruleset.yaml using the write tool. This is the step
   that makes the revision real. Do not skip it, and do not retype the
   file by hand.
4. Report the updated catch-rate and false-positive deltas, and say
   plainly whether the feedback improved the trade or not — if the
   analyst's suggestion is worse than your original, say so.
5. End with a COMMIT_MSG line.`;

function fallbackCommitMsg(incidentDescription: string): string {
  const words = incidentDescription.trim().split(/\s+/).slice(0, 8).join(" ");
  return `Update ruleset re: ${words}`.slice(0, 72);
}

async function toClientView(p: store.StoredProposal | undefined): Promise<ProposalView | null> {
  if (!p) return null;
  const [diff, behindMain] = await Promise.all([
    diffProposalAgainstMain(p.handle),
    commitsBehindMain(p.handle),
  ]);
  return {
    id: p.id,
    branch: p.handle.branch,
    incidentDescription: p.incidentDescription,
    createdAt: p.createdAt,
    turns: p.turns,
    recovered: p.recovered,
    phase: p.phase,
    phaseLabel: p.phaseLabel,
    startedAt: p.startedAt,
    lastError: p.lastError,
    diff,
    hadChanges: Boolean(diff.trim()),
    behindMain,
    conflict: p.conflict,
  };
}

/**
 * Runs one agent turn in the background. The HTTP request that started
 * it has already returned: a model call takes tens of seconds, and a
 * request held open that long is a spinner the analyst can't interrupt,
 * a proposal they can't switch away from, and a request the platform may
 * time out from under them. Progress is read back by polling GET /:id.
 */
async function runTurnInBackground(p: store.StoredProposal, prompt: string, label: string): Promise<void> {
  const abort = new AbortController();
  p.abort = abort;
  store.setPhase(p.id, "running", label);

  try {
    const result = await runAgentTurn({ agentDir: p.handle.agentDir, prompt, signal: abort.signal });
    const commitMsg = result.commitMsg || fallbackCommitMsg(p.incidentDescription);

    const turn: ProposalTurn = {
      role: "agent",
      text: result.text,
      at: new Date().toISOString(),
      backtest: result.backtest,
      commitMsg: result.commitMsg,
      backtestError: result.backtestError,
      providerAttempts: result.providerAttempts,
      costUsd: result.costUsd,
    };
    store.addTurn(p.id, turn);

    // The transcript is written from the store *after* the turn is
    // recorded, so the commit that carries the rule edit also carries
    // the reasoning that produced it.
    const { unexpectedFileChanges, rulesetChanged } = await commitProposalChanges(
      p.handle,
      commitMsg,
      [store.transcriptFor(p)],
    );
    turn.unexpectedFileChanges = unexpectedFileChanges;
    turn.noRulesetChange = !rulesetChanged;

    store.setPhase(p.id, "idle");
  } catch (err) {
    if (err instanceof AgentCancelledError) {
      store.setPhase(p.id, "cancelled");
      return;
    }
    if (err instanceof AllProvidersFailedError) {
      store.addTurn(p.id, {
        role: "agent",
        text: "",
        at: new Date().toISOString(),
        providerAttempts: err.attempts,
      });
      store.setError(p.id, err.message);
      return;
    }
    store.setError(p.id, err instanceof Error ? err.message : String(err));
  }
}

proposalsRouter.get("/", async (_req, res) => {
  const views = await Promise.all(store.list().map(toClientView));
  res.json({ proposals: views.filter(Boolean) });
});

proposalsRouter.get("/:id", async (req, res) => {
  const p = store.get(req.params.id);
  if (!p) return res.status(404).json({ error: "This proposal is no longer open." });
  res.json(await toClientView(p));
});

proposalsRouter.post("/", async (req, res) => {
  const { incidentDescription } = req.body as { incidentDescription?: string };
  if (!incidentDescription?.trim()) {
    return res.status(400).json({ error: "Describe what you're seeing before drafting a proposal." });
  }
  if (buildModelChain().length === 0) {
    // Checked before the worktree exists: a deployment with no key can
    // never draft, and leaving an empty branch behind for every attempt
    // just litters the repo the product is supposed to keep readable.
    return res.status(503).json({
      error: "No model provider is configured, so there is nothing to draft with. Set an API key and restart.",
    });
  }

  let handle;
  try {
    handle = await createProposal(incidentDescription);
  } catch (err) {
    return res.status(500).json({ error: `Could not create the proposal branch: ${String(err)}` });
  }

  const p = store.create(handle, incidentDescription);
  const prompt = INITIAL_INSTRUCTIONS.replace("{{INPUT}}", incidentDescription);
  void runTurnInBackground(p, prompt, "Drafting a rule change");
  res.status(202).json(await toClientView(p));
});

proposalsRouter.post("/:id/iterate", async (req, res) => {
  const p = store.get(req.params.id);
  if (!p) return res.status(404).json({ error: "This proposal is no longer open." });
  if (p.phase === "running") return res.status(409).json({ error: "The agent is still working on this proposal." });

  const { feedback } = req.body as { feedback?: string };
  if (!feedback?.trim()) return res.status(400).json({ error: "Say what needs to change." });

  store.addTurn(p.id, { role: "analyst", text: feedback, at: new Date().toISOString() });

  const lastAgentTurn = [...p.turns].reverse().find((t) => t.role === "agent" && t.text.trim());
  const prompt = ITERATE_INSTRUCTIONS.replace(
    "{{PREVIOUS}}",
    lastAgentTurn?.text ?? "(no previous response on file)",
  ).replace("{{INPUT}}", feedback);

  void runTurnInBackground(p, prompt, "Revising the proposal");
  res.status(202).json(await toClientView(p));
});

proposalsRouter.post("/:id/cancel", async (req, res) => {
  const p = store.get(req.params.id);
  if (!p) return res.status(404).json({ error: "This proposal is no longer open." });
  p.abort?.abort();
  res.json(await toClientView(p));
});

proposalsRouter.post("/:id/approve", async (req, res) => {
  const p = store.get(req.params.id);
  if (!p) return res.status(404).json({ error: "This proposal is no longer open." });
  if (p.phase === "running") {
    return res.status(409).json({ error: "The agent is still working — stop the run before merging." });
  }

  const { analystNote } = req.body as { analystNote?: string };
  // The message has to come from the turn that actually changed the
  // ruleset, not simply the last one. An iteration that backtested an
  // alternative and then didn't write it still carries a COMMIT_MSG
  // describing the change it decided against — observed live, where a
  // merge of a 25,000 threshold was about to be logged as
  // "Adjust new-device velocity threshold to 35,000".
  const authoring = [...p.turns]
    .reverse()
    .find((t) => t.role === "agent" && t.commitMsg && t.noRulesetChange !== true);
  const commitMsg =
    authoring?.commitMsg ||
    [...p.turns].reverse().find((t) => t.role === "agent" && t.commitMsg)?.commitMsg ||
    fallbackCommitMsg(p.incidentDescription);

  try {
    await approveProposal(p.handle, commitMsg, analystNote ?? "");
    store.remove(p.id);
    res.json({ ok: true });
  } catch (err) {
    if (err instanceof MergeConflictError) {
      // main moved under this branch. The merge has been unwound, so
      // main is clean and the branch is untouched -- the analyst can
      // still read it, reject it, or re-run it against current main.
      store.setConflict(p.id, { paths: err.paths, at: new Date().toISOString() });
      return res.status(409).json({ error: err.message, conflict: err.paths });
    }
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

proposalsRouter.post("/:id/reject", async (req, res) => {
  const p = store.get(req.params.id);
  if (!p) return res.status(404).json({ error: "This proposal is no longer open." });
  if (p.phase === "running") {
    return res.status(409).json({ error: "The agent is still working — stop the run before rejecting." });
  }

  const { analystNote } = req.body as { analystNote?: string };
  try {
    await rejectProposal(p.handle, analystNote ?? "");
    store.remove(p.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/**
 * Drops a proposal that never produced anything -- a run that failed
 * before the agent wrote a line. No memory entry, because nothing was
 * ever decided; recording "rejected" for a branch the analyst never got
 * to read would put a lie in the agent's memory.
 */
proposalsRouter.post("/:id/discard", async (req, res) => {
  const p = store.get(req.params.id);
  if (!p) return res.status(404).json({ error: "This proposal is no longer open." });
  if (p.turns.some((t) => t.role === "agent" && t.text.trim())) {
    return res.status(409).json({ error: "This proposal has agent output — reject it so the decision is recorded." });
  }
  try {
    p.abort?.abort();
    await discardProposal(p.handle);
    store.remove(p.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});
