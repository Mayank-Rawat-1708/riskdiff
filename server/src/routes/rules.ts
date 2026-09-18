import { Router } from "express";
import {
  getLiveRulesetText,
  parseRuleSummaries,
  getHistory,
  getCommitDiff,
  revertToParentOf,
} from "../repoManager.js";

export const rulesRouter = Router();

rulesRouter.get("/", async (_req, res) => {
  try {
    const yaml = await getLiveRulesetText();
    const rules = parseRuleSummaries(yaml);
    const history = await getHistory();
    res.json({ yaml, rules, history });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

rulesRouter.get("/history/:sha", async (req, res) => {
  try {
    const diff = await getCommitDiff(req.params.sha);
    res.json({ diff });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

rulesRouter.post("/revert", async (req, res) => {
  const { sha, note } = req.body as { sha?: string; note?: string };
  if (!sha) return res.status(400).json({ error: "sha is required" });
  try {
    await revertToParentOf(sha, note ?? "");
    const yaml = await getLiveRulesetText();
    res.json({ yaml, rules: parseRuleSummaries(yaml), history: await getHistory() });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});
