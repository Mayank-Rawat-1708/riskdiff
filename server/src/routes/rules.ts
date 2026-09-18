import { Router } from "express";
import {
  getLiveRulesetText,
  parseRuleSummaries,
  getHistory,
  getCommitDiff,
  revertToParentOf,
  NotRevertableError,
} from "../repoManager.js";

export const rulesRouter = Router();

async function snapshot() {
  const yaml = await getLiveRulesetText();
  return { yaml, rules: parseRuleSummaries(yaml), history: await getHistory() };
}

rulesRouter.get("/", async (_req, res) => {
  try {
    res.json(await snapshot());
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

rulesRouter.get("/history/:sha", async (req, res) => {
  if (!/^[0-9a-f]{7,40}$/i.test(req.params.sha)) {
    return res.status(400).json({ error: "Not a commit id." });
  }
  try {
    res.json(await getCommitDiff(req.params.sha));
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

rulesRouter.post("/revert", async (req, res) => {
  const { sha, note } = req.body as { sha?: string; note?: string };
  if (!sha) return res.status(400).json({ error: "Which commit?" });
  try {
    await revertToParentOf(sha, note ?? "");
    res.json(await snapshot());
  } catch (err) {
    // A rollback git can't express is a 422, not a 500: the request was
    // understood, the repository just has no earlier state to restore.
    if (err instanceof NotRevertableError) return res.status(422).json({ error: err.message });
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});
