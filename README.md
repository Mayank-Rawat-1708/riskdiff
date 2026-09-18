# RiskDiff

A transaction risk policy workbench built on [GitAgent](https://github.com/open-gitagent/gitagent) / OpenGAP.

Fraud rules at a fintech change constantly, and every change is a bet in
two directions at once: tighten too far and you decline paying customers,
loosen too far and you eat chargebacks. In most teams that change is a
Slack message, a deploy, and a hope. RiskDiff makes it a reviewable
proposal with a backtest attached, and makes the whole decision history
a git history you can read, diff, and roll back.

**Who it's for:** a risk/fraud analyst who owns the transaction
monitoring ruleset — the person who gets pinged when the review queue
blows up or when a chargeback cluster gets through.

---

## The division of labor

The point of a workbench is that the human and the agent each have a job
neither can do alone.

| | The agent (Riska) | The analyst |
|---|---|---|
| Drafts rule changes | ✓ | |
| Runs backtests over 600 historical transactions | ✓ | |
| Reads prior decisions before proposing | ✓ | |
| Decides what the business can tolerate | | ✓ |
| Merges anything to `main` | | ✓ |
| Rolls back a live rule | | ✓ |

The agent never reaches `main`. Every path from "proposed" to "live"
passes through an explicit analyst action. That's not a policy written
in a prompt and hoped for — it's enforced three ways: the server only
ever runs the agent in a worktree checked out on a `proposal/*` branch,
a programmatic `preToolUse` hook refuses `write`/`cli` on `main`, and a
shell hook in `agent/hooks/` does the same for anyone running the bare
`gitagent` CLI against the directory.

## What makes it git-native rather than git-flavored

Each of these is load-bearing, not decoration:

- **A proposal is a branch.** `createProposal()` makes a real `git
  worktree` on a `proposal/*` branch. The agent works there, in
  isolation, with its own checkout.
- **Approval is a merge.** Approving squash-merges the branch into
  `main`. The ruleset change and the analyst's reasoning land in the
  same commit.
- **Memory is commits.** Every approve, reject, and revert appends to
  `agent/memory/MEMORY.md` *in that same commit*. `git log` on the
  ruleset and `git log` on the memory file tell the same story from two
  angles. The agent reads that memory before drafting, so "we already
  tried this in July and reverted it" is something it can actually know.
- **Rejection is also recorded.** A rejected proposal deletes the
  branch but still commits a memory entry saying what was rejected and
  why — otherwise the agent would happily re-propose it next week.
- **Rollback is a forward commit**, never a history rewrite. Reverting
  writes the prior content as a new commit, so the record of the bad
  rule *and* the decision to pull it both survive.
- **Rules are diffable.** `RULES.md` and `active-ruleset.yaml` are
  plain files in the repo. The right pane of the UI is literally a git
  diff.

## Running it

```bash
cp .env.example .env     # add at least one model API key
npm run install:all
npm run build
npm start                # http://localhost:8080
```

With no `GIT_REPO_URL` set, it runs in **local-only mode**: it seeds a
throwaway git repo from `agent/` and every git operation works
normally, it just never pushes. Set `GIT_REPO_URL` + `GITHUB_PAT` to
have approved changes pushed to a real repo.

Two tests run without any API key, because the git mechanics don't
depend on a model being reachable:

```bash
npm run test:lifecycle   # propose → commit → diff → approve → revert
npm run test:smoke       # boot, serve, read the live ruleset
```

## Model fallback

The server builds its provider chain from whichever keys are present,
skipping providers with no key rather than burning a call on a
guaranteed auth failure:

```
groq:openai/gpt-oss-120b → groq:llama-3.3-70b-versatile
→ groq:llama-3.1-8b-instant → openai:gpt-4o-mini
→ anthropic:claude-sonnet-4-5
```

Every attempt is surfaced in the UI rather than swallowed. If Groq is
out of credits, the analyst sees *"Groq / GPT-OSS 120B failed — …, fell
back to OpenAI / GPT-4o mini"* under the agent's response. A silent
fallback would mean an analyst can't tell which model's judgment they're
about to merge into production policy.

## Layout

```
agent/                    the OpenGAP agent — this directory IS the agent
  agent.yaml              manifest: model chain, tools, compliance block
  SOUL.md                 identity
  RULES.md                behavioral constraints (diffable, versioned)
  DUTIES.md               role split, validated against the compliance block
  memory/MEMORY.md        decision log, written as commits
  rules/active-ruleset.yaml   the live policy
  data/transactions.csv   600 synthetic labeled transactions
  tools/backtest.yaml     declarative tool + scripts/backtest.mjs
  hooks/                  branch guard + error logging
  skills/risk-policy-drafting/
server/                   Express API: git mechanics + gitagent SDK
web/                      React workbench UI
scripts/                  dataset generator, lifecycle test, smoke test
```

See `NOTES.md` for what's broken, what was cut, and why.

MIT.
