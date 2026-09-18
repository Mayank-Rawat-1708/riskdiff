import { Router } from "express";
import {
  createProposal,
  commitProposalChanges,
  diffProposalAgainstMain,
  approveProposal,
  rejectProposal,
} from "../repoManager.js";
import { runAgentTurn } from "../agentRunner.js";
import * as store from "../proposalStore.js";

export const proposalsRouter = Router();

const INITIAL_INSTRUCTIONS = `An analyst on the transaction risk team reported the pattern below. Read
rules/active-ruleset.yaml and the last several entries of memory/MEMORY.md
yourself (you have read access), then follow the risk-policy-drafting
skill: restate the pattern in one sentence, check memory for anything
related, change exactly one rule using the write tool on
rules/active-ruleset.yaml, call the backtest tool with the FULL
candidate rule list (every rule, not just the one you changed), and
report catch-rate / false-positive-rate deltas plus your honest
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

Re-read your current draft of rules/active-ruleset.yaml on this branch,
revise it per the feedback, re-run the backtest tool with the full
updated rule list, and report the updated findings. End with a
COMMIT_MSG line.`;

function fallbackCommitMsg(incidentDescription: string): string {
  const words = incidentDescription.trim().split(/\s+/).slice(0, 8).join(" ");
  return `Update ruleset re: ${words}`.slice(0, 72);
}

proposalsRouter.get("/", (_req, res) => {
  res.json({ proposals: store.list().map(toClientView) });
});

proposalsRouter.get("/:id", (req, res) => {
  const p = store.get(req.params.id);
  if (!p) return res.status(404).json({ error: "not found" });
  res.json(toClientView(p));
});

proposalsRouter.post("/", async (req, res) => {
  const { incidentDescription } = req.body as { incidentDescription?: string };
  if (!incidentDescription?.trim()) {
    return res.status(400).json({ error: "incidentDescription is required" });
  }
  try {
    const handle = await createProposal(incidentDescription);
    const p = store.create(handle, incidentDescription);

    const prompt = INITIAL_INSTRUCTIONS.replace("{{INPUT}}", incidentDescription);
    const result = await runAgentTurn({ agentDir: handle.agentDir, prompt });

    const commitMsg = result.commitMsg || fallbackCommitMsg(incidentDescription);
    const { unexpectedFileChanges, hadChanges } = await commitProposalChanges(handle, commitMsg);

    store.addTurn(p.id, {
      role: "agent",
      text: result.text,
      at: new Date().toISOString(),
      backtest: result.backtest,
      commitMsg: result.commitMsg,
      unexpectedFileChanges,
      providerAttempts: result.providerAttempts,
    });

    const diff = hadChanges ? await diffProposalAgainstMain(handle) : "";
    res.json({ ...toClientView(store.get(p.id)!), diff, hadChanges });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

proposalsRouter.post("/:id/iterate", async (req, res) => {
  const p = store.get(req.params.id);
  if (!p) return res.status(404).json({ error: "not found" });
  const { feedback } = req.body as { feedback?: string };
  if (!feedback?.trim()) return res.status(400).json({ error: "feedback is required" });

  store.addTurn(p.id, { role: "analyst", text: feedback, at: new Date().toISOString() });

  const lastAgentTurn = [...p.turns].reverse().find((t) => t.role === "agent");
  const prompt = ITERATE_INSTRUCTIONS.replace("{{PREVIOUS}}", lastAgentTurn?.text ?? "(no previous response on file)").replace(
    "{{INPUT}}",
    feedback,
  );

  try {
    const result = await runAgentTurn({ agentDir: p.handle.agentDir, prompt });
    const commitMsg = result.commitMsg || fallbackCommitMsg(feedback);
    const { unexpectedFileChanges, hadChanges } = await commitProposalChanges(p.handle, commitMsg);

    store.addTurn(p.id, {
      role: "agent",
      text: result.text,
      at: new Date().toISOString(),
      backtest: result.backtest,
      commitMsg: result.commitMsg,
      unexpectedFileChanges,
      providerAttempts: result.providerAttempts,
    });

    const diff = await diffProposalAgainstMain(p.handle);
    res.json({ ...toClientView(store.get(p.id)!), diff, hadChanges });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

proposalsRouter.post("/:id/approve", async (req, res) => {
  const p = store.get(req.params.id);
  if (!p) return res.status(404).json({ error: "not found" });
  const { analystNote } = req.body as { analystNote?: string };

  const lastAgentTurn = [...p.turns].reverse().find((t) => t.role === "agent");
  const commitMsg = lastAgentTurn?.commitMsg || fallbackCommitMsg(p.incidentDescription);

  try {
    await approveProposal(p.handle, commitMsg, analystNote ?? "");
    store.remove(p.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

proposalsRouter.post("/:id/reject", async (req, res) => {
  const p = store.get(req.params.id);
  if (!p) return res.status(404).json({ error: "not found" });
  const { analystNote } = req.body as { analystNote?: string };

  try {
    await rejectProposal(p.handle, analystNote ?? "");
    store.remove(p.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

function toClientView(p: ReturnType<typeof store.get>) {
  if (!p) return null;
  return {
    id: p.id,
    branch: p.handle.branch,
    incidentDescription: p.incidentDescription,
    createdAt: p.createdAt,
    turns: p.turns,
    recovered: p.recovered ?? false,
  };
}
