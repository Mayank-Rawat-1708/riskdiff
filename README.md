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
  why — otherwise the agent would happily re-propose it next week. The
  conversation that argued for it is archived alongside, so the agent
  can read not just *that* something was turned down but *what it
  claimed*.
- **The conversation is committed too.** Every turn is written to
  `agent/proposals/<branch>.json` in the same commit as the rule edit
  it produced. It survives a server restart, it diffs like anything
  else in the repo, and on a decision it lands on `main` stamped
  approved or rejected. The reasoning is as git-native as the rule.
- **Rollback is a forward commit**, never a history rewrite. Reverting
  writes the prior content as a new commit, so the record of the bad
  rule *and* the decision to pull it both survive.
- **Rules are diffable, and stay that way.** `RULES.md` and
  `active-ruleset.yaml` are plain files in the repo, and the right pane
  of the UI is literally a git diff. The `backtest` tool hands the
  agent back the live file with *only its change applied* rather than a
  re-serialization of it, so a one-line threshold change is a two-line
  diff — the threshold and the version bump — with every comment and
  every untouched line byte-identical. `npm run test:backtest` asserts
  that by diffing the output.

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

### Tests

Both run without any API key, because the git mechanics don't depend on
a model being reachable:

```bash
npm test
```

- `npm run test:lifecycle` — 37 checks over the full git cycle:
  concurrent proposals, a merge conflict on approval (and that `main`
  is left clean afterwards), rejection, recovery of an open proposal
  after a restart, the rollback guards, and that a one-line rule change
  stays a one-line diff.
- `npm run test:backtest` — 24 checks driving the backtest tool through
  its real stdin/stdout contract, asserting on the *size of the
  resulting diff* as well as the numbers.
- `npm run test:smoke` — boots the server, reads the live ruleset,
  shuts down.

### Designing without burning credits

```bash
npm run dev:fixtures     # :8080, every UI state at once
npm run dev:web          # :5173, proxies /api to it
```

`scripts/ui-fixtures.mjs` serves the same API shapes with one proposal
per state — drafting, fell back to another provider, agent skipped its
own backtest, all providers failed, conflicts with `main`, recovered
after a restart — so the screens that only exist when something goes
wrong can be worked on deliberately. It is not part of the product and
says so at the top of the file. Its backtest numbers come from running
the real tool against the real dataset.

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

## The interface

Three panes, and the split is the point: **state** (what is true on
`main`, what's pending, what was decided), **work** (the conversation
with the agent), **evidence** (what you decide from).

The evidence pane is the one that got the most care, because it's where
the decision actually happens. The diff puts `+`/`−` in a gutter beside
old and new line numbers and highlights the characters that changed, so
a threshold edit lands your eye on `50000 → 25000`. The backtest
reports both directions of the trade in rates *and* counts, and then
says it in the unit an analyst argues in: *"catches +4 frauds and sends
+11 legitimate transactions to manual review — about 2.8 false
positives per additional catch."*

Dark is the default and the primary design target; the light theme is a
rebalance rather than an inversion, and the toggle sits in the status
bar. Every state is designed, including the ones nobody wants: the
agent skipping its own backtest, a branch that no longer merges, a run
where every provider failed, a proposal recovered from git with its
conversation gone.

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
  proposals/              archived conversations, written on decision
  skills/risk-policy-drafting/
server/                   Express API: git mechanics + gitagent SDK
web/                      React workbench UI
  src/styles/             design tokens, then one file per pane
scripts/                  dataset generator, tests, UI design harness
```

See `NOTES.md` for what's broken, what was cut, and why.

MIT.
