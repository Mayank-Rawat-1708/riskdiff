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

Node 20 or newer.

```bash
git clone https://github.com/Mayank-Rawat-1708/riskdiff.git
cd riskdiff
cp .env.example .env     # then add one model API key, see below
npm run install:all
npm run build
npm start                # http://localhost:8080
```

On boot the server prints what it resolved, so a misconfigured
deployment says so before you click anything:

```
RiskDiff listening on :8080
  .env         /path/to/riskdiff/.env
  runtime dir  /tmp/riskdiff-runtime
  git          local-only (no GIT_REPO_URL)
  models       Groq / GPT-OSS 120B → Groq / GPT-OSS 20B → Groq / GPT-OSS Safeguard 20B
```

### What you need in `.env`

Only one thing is required: **one model API key**, any of
`GROQ_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`. Everything else
has a working default, and blank means unset — leave a line empty and
you get the default rather than an empty string.

| | |
|---|---|
| `GROQ_API_KEY` / `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` | At least one. The fallback chain is built from whichever are present; a provider with no key is skipped rather than tried and failed. |
| `MODEL_CHAIN` | Optional. Comma-separated `provider:model` ids that replace the chain entirely — pin a model, or exercise the weak end of the chain deliberately. |
| `AGENT_TIMEOUT_MS` | Optional, default 180000. Wall-clock ceiling on one model's attempt. |
| `GIT_REPO_URL` + `GITHUB_PAT` | Optional. Leave both blank for local-only mode. |
| `RUNTIME_DIR` | Optional, defaults to a temp directory. Where the server keeps its working clone. |
| `PORT` | Optional, default 8080. |

**Without any key**, the workbench still runs and most of it still
works: the live ruleset, the decision history, every past diff, commit
inspection and rollback all read from git and need no model. Only
drafting a new proposal needs one, and the composer says so rather than
failing when you press the button.

**Without `GIT_REPO_URL`** it runs in local-only mode: it seeds a
throwaway git repo from `agent/` and every git operation works
normally, it just never pushes. Set `GIT_REPO_URL` + `GITHUB_PAT` to
have approved changes pushed to a real repo.

### A note on free provider tiers

Groq's free tier allows 8,000 tokens per minute and 200,000 per day,
per organisation. One agent turn measures 4,000–8,500 input tokens, so
on that tier the workbench is comfortable with **one proposal at a
time** and will rate-limit itself under concurrent use. It handles that
visibly — the retry hint is honoured, every attempt and its reason
appear in the UI — but if you are demoing several proposals in a row,
expect to see the fallback chain working. See NOTES.md.

### Tests

Both run without any API key, because the git mechanics don't depend on
a model being reachable:

```bash
npm test
```

**`npm run test:lifecycle`** — 37 checks proving the git mechanics are
real. It creates two concurrent proposals in separate worktrees, edits
and commits on each, approves one (squash-merge + memory entry +
archived conversation in a single commit), then approves the second and
asserts that the conflict is caught, that `main` is left clean
afterwards, and that no conflict markers reach the ruleset. It rejects
the second and asserts the decision is still recorded. It simulates a
server restart and asserts the open proposals come back from their
branches with their conversations. It asserts the root commit refuses
rollback, rolls back a real change as a forward commit, and checks
nothing was rewritten. And it asserts that a one-line threshold change
produces a one-line diff — the property the bespoke YAML handling
exists to protect.

**`npm run test:backtest`** — 24 checks driving the backtest tool
through its real stdin/stdout contract: that the numbers are
believable rather than suspiciously perfect, that both directions of
the trade are reported, that unsupported inputs produce a warning
rather than a confident wrong answer — and, for each kind of edit, the
*size of the resulting diff*, by actually diffing the output against
the live file.

**`npm run test:smoke`** — boots the server, reads the live ruleset,
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
groq:openai/gpt-oss-120b → groq:openai/gpt-oss-20b
→ groq:openai/gpt-oss-safeguard-20b → openai:gpt-4o-mini
→ anthropic:claude-sonnet-4-5
```

Every attempt is surfaced in the UI rather than swallowed — the model
that answered, the ones that didn't and why, how long each took and how
many tokens it needed. A silent fallback would mean an analyst can't
tell whose judgement is in the diff they're about to merge, and a 20B
fallback and a 120B primary do not warrant the same amount of trust.

Model ids are checked against the provider's live catalogue *and*
against the SDK's own model registry, because the two disagree in both
directions. Two ids sat dead in this chain for a while returning 404 on
every call — invisible while the first model works. NOTES.md has the
details.

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
