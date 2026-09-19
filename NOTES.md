# NOTES

What's broken, what was cut, and the calls I'd defend in a review.

Written to be true as of the last commit, not as of when each part was
built. Where something was wrong and got fixed, the bug is described
rather than quietly erased — most of them were only findable by running
the thing, and how they were found is the useful part.

---

## Bugs that were real

### A merge conflict wrote conflict markers into the live ruleset

The worst one. `approveProposal` detected a failed squash-merge by
catching an exception — but simple-git's `raw()` **resolves** on git's
non-zero exit for a conflicted merge. The code saw success, committed
the conflicted working tree, and put a ruleset containing `<<<<<<< HEAD`
on `main`. Two analysts approving two proposals that touch the same
threshold is not exotic; it's Tuesday.

Conflicts are now read off the index (`diff --diff-filter=U`), the
failed merge is unwound so `main` is left clean, and the caller gets a
typed `MergeConflictError` naming the paths. The lifecycle test
reproduces it.

### Every live proposal failed, for three unrelated reasons

The agent's success path had never once executed against a real key.
Three separate faults were stacked on top of each other.

**Dead model ids.** `llama-3.3-70b-versatile` and `llama-3.1-8b-instant`
were decommissioned by Groq on 2026-08-16 and 404 on every call. Two
thirds of the fallback chain had been dead the whole time and nothing
said so, because a chain only reveals itself when the first entry
fails. Every id is now checked twice — against `GET /v1/models` on a
live key, and against pi-ai's bundled registry — because the two
disagree in both directions (see the Qwen note below).

**The SDK advertised tools it was then denied.** This was the blocker.
gitagent assembles a system prompt that unconditionally instructs the
model to *"FIRST: Call `task_tracker` action begin … Do NOT skip step
1"*, and filters the tool array by `allowedTools` **afterwards**. The
model did as it was told, and the provider rejected the entire request:

```
Tool call validation failed: attempted to call tool 'task_tracker'
which was not in request.tools
```

Provider-independent and fatal — every model in the chain reads the
same contradictory prompt, so the fallback chain just produced three
different downstream symptoms of one cause.

Fixed by making the advertised set and the permitted set the same set.
The server loads the SDK's prompt itself, strips the sections and
sentences advertising tools this deployment withholds, and appends an
explicit list of what exists. The scrub checks its own work: anything
still named afterwards gets an explicit denial appended and a warning
logged, so a reworded SDK release degrades into a redundant sentence
instead of a dead agent.

**Empty env vars read as set.** `process.env.X ?? fallback` only falls
back on `undefined`, and `.env.example` ships every key blank — so
`RUNTIME_DIR=` was `mkdir('')` at boot, and an empty `GIT_REPO_URL=`
would have convinced the server it had a remote and sent it to clone
`""`. Blank means unset everywhere now, and startup prints which `.env`
was read, the runtime directory, the git mode and the resolved chain.

### Tools that commit behind the server's back

Three of the SDK's built-in tools run their own `git commit`.
`memory` shells out to `git add && git commit` on every save —
interpolating the model's own message into that shell string —
and `skill_learner` does the same when it crystallizes a skill. Those
commits land on the proposal branch with messages the server never
authored, and squash-merge into `main` on approval. The product's claim
is that every commit is the server's; two tools on the allowlist
quietly weren't.

The agent now holds exactly `read`, `write`, `backtest`. Memory is
written by the server at decision time, so the agent only ever needed
to read it. `cli` stays out for a related reason: a shell in the
worktree is a way to reach `main` — `git update-ref refs/heads/main
<sha>` moves the branch even while it's checked out elsewhere, and one
call does that before the branch guard looks again.

### The backtest tool told the agent to destroy its own diff

The tool returned `formatted_yaml`, a full re-serialization of the
candidate ruleset, and its description said to write that verbatim into
the file. Comments gone, every folded `description: >` unfolded onto one
line. An agent following its own tool correctly would have turned every
one-line threshold change into a whole-file diff — the one thing this
product cannot afford.

It now returns `patched_yaml`: the live file with only the changed
scalars moved, by line position rather than parse/dump. A one-line rule
change is a two-line diff (the threshold and the version bump). If the
surgical edit doesn't re-parse to the ruleset that was actually scored,
it falls back to full re-serialization and says so in `warnings` — a
wrong file is worse than an ugly diff, and the analyst is told which
one they got.

While fixing it: the tool's YAML parser never folded `description: >`
continuation lines, so every description parsed as empty and the
patcher thought all three had changed on every call.

### Two things only driving the real UI could have found

**An iteration that backtests but never writes.** Asked to try 35,000
instead of 25,000, the agent read the branch, called `backtest`
correctly on 25,000 → 35,000, reported accurate deltas — and never
wrote the file. The server caught it (`noRulesetChange`) and the
workbench said so plainly ("The agent replied but left
rules/active-ruleset.yaml untouched"), which is the designed
behaviour and the reason it was visible at all. But it's a
reliability gap: the iterate prompt was a paragraph where the initial
prompt was a numbered procedure, and the weaker model followed the
one that was easier to follow. The iterate instructions are now
numbered, and step 3 says in as many words that a revision which
stops before writing is not a revision.

Worth being precise about what is *not* fixed here: the server does
not write the file on the agent's behalf when this happens. It could
— `patched_yaml` is right there — but the agent may have backtested
an option in order to argue against it, and silently applying a
change it decided against would be worse than showing the analyst
that nothing happened.

**A commit message describing a change that wasn't made.** Following
directly from the above: `approve` took its message from the last
agent turn, and that turn was the one that backtested 35,000 and
wrote nothing. A merge of a 25,000 threshold was about to be logged
on `main` as "Adjust new-device velocity threshold to 35,000" —
permanently, in the file that is supposed to read as a policy
changelog. The message now comes from the last turn that actually
changed the ruleset.

### Rollback offered where rollback is impossible

The root commit has no parent, so `git show <root>^` could only throw.
Same for memory-only decision commits — a rejection changes no rule, so
there's no rule state to restore. History entries carry
`isRoot`/`canRevert`, the UI hides the button, and the server answers
422 with a sentence instead of 500 with a stack trace.

### Smaller ones

- A push failure after a successful local merge unwound the whole
  approve as an error, losing the fact that the merge had landed. It's
  recorded and shown in the status bar instead.
- History was keyed on the ruleset alone, so rejections — which only
  touch `MEMORY.md` — never appeared in the timeline at all. The one
  thing the product claims about turning something down, and it wasn't
  in the record the UI renders.
- The gitagent SDK writes `agent/.gitagent/state.json` into whatever
  directory it runs against. A different session id per branch, so it
  was committed to each branch, reported to the analyst as "the agent
  edited files outside the ruleset" (a false accusation), and made
  every pair of concurrent proposals conflict with each other over a
  session id.
- Nothing bounded an agent turn. `agent.yaml` declares
  `runtime.timeout: 90`; nothing in this path enforced it, and pi-ai
  builds its OpenAI client without setting `maxRetries` or `timeout`,
  so the official SDK's defaults apply — two internal retries honouring
  `Retry-After`, ten-minute ceiling, *per turn*. A rate-limited six-turn
  proposal was measured at **2,203 seconds** before answering. It
  answered correctly, which is worse than failing.

---

## What the live runs actually showed

Against a real Groq key, after the fixes: **eight proposals in which a
provider answered, and all eight were compliant** on the four things
that matter — backtest called before the recommendation, a surgical
two-line diff with comments and folded descriptions untouched, a
`COMMIT_MSG:` line, and the correct rule targeted (travel complaints →
`geo-mismatch`, spacing-out bursts → `rapid-succession`, new-device
chargebacks → `velocity-new-device`).

That includes one run pinned to the weakest model in the chain
(GPT-OSS 20B via `MODEL_CHAIN`), which was rate-limited, waited out the
retry, and then produced a correct `geo-mismatch` proposal.

The full analyst loop was then driven through the UI against the live
key: propose → iterate → approve → inspect the merged commit → roll
back, and separately a rejection. Both primary models were
rate-limited at the time, so the proposal that got merged was drafted
by **GPT-OSS Safeguard 20B** — the third entry in the chain — which is
the fallback working exactly as advertised, visible in the provider
trail with the two struck-through attempts above it. Approval put the
rule change, the analyst's note in `MEMORY.md` and the archived
conversation in one commit; rollback wrote a forward commit leaving
both itself and the change it undid in the log; rejection deleted the
branch and still recorded the reasoning. The rejection was exercised
on a hand-seeded branch rather than a live draft, because by that
point the day's token allowance was gone — the same path is asserted
four ways in the lifecycle test.

**Every failure in testing was the provider's rate limit, not the
agent.** This key is on Groq's free tier: 8,000 tokens per minute and
200,000 per day, per organisation. A single agent turn measured
3,854–8,490 input tokens. So one turn can consume an entire minute's
budget, a multi-turn proposal necessarily hits 429s, and a request
above 8,000 is rejected outright with a 413 rather than queued. Running
five proposals back to back exhausted the daily allowance.

That is an account tier, not a bug, and the honest position is that
this deployment is **reliable one proposal at a time on this tier** and
would need a paid tier to be reliable under concurrent use. What the
code does about it:

- Trimmed the request. Dropping SDK prompt sections that don't apply
  here and narrowing the tool set took the system prompt from 10,876 to
  8,918 characters and removed ~420 tokens of tool schema.
- Honours the retry hint on a 429 rather than falling down the chain —
  the TPM budget is per *organisation*, so the next model is exactly as
  rate-limited as the one that just failed.
- Bounds each attempt (`AGENT_TIMEOUT_MS`, default 180s) so a turn
  can't run for thirty-seven minutes.
- Reports peak input tokens per attempt in the provider trail, because
  on this tier that's the number that decides whether a turn is even
  accepted.
- Shows all of it. Every attempt, every reason, in the UI.

One more thing the live runs turned up: GPT-OSS 20B killed a run by
calling a tool nobody offered it — `attempted to call tool 'search'`.
The gpt-oss family is trained with a browser/search/python harness and
reaches for it unprompted, and a hallucinated call fails the whole
request the same way the `task_tracker` mismatch did. The tools block
now names the usual suspects as unavailable. It isn't a guarantee;
it's a mitigation for a class of failure that is visible when it
happens.

---

## Still broken, on purpose

**The frequency rule's backtest only understands a 10-minute window.**
The dataset precomputes `account_tx_count_10min`, so a proposal setting
`window_minutes: 30` is scored against the 10-minute count. The tool
warns loudly rather than silently returning a wrong number, and the UI
prints the warning next to the metric it qualifies. A visible
approximation beats an invisible one. Real timestamp-window evaluation
is about thirty minutes of work and it's the first thing I'd do next.

**The YAML handling is bespoke.** A line-position patcher rather than a
parse/dump: strictly better for diffs, strictly worse for schema
growth. The mitigation is the round-trip self-check described above. A
comment-preserving YAML CST is the right answer if the schema grows
past what RULES.md item 2 keeps small.

**Qwen3.8 27B is not in the chain**, and the reason is worth recording
because it's a trap. It's live on Groq, but absent from pi-ai's bundled
registry, so `getModel()` returns `undefined` and the SDK dies
dereferencing it — *"Cannot read properties of undefined (reading
'headers')"* in 0ms, before any HTTP call, which reads like a network
bug and isn't one. The SDK's custom-endpoint escape hatch
(`provider:id@base-url`) does construct it, but ignores
`constraints.maxTokens` and sends a `max_completion_tokens` above
Qwen's 16,384 ceiling, so every request 400s. Left out rather than
worked around. Note also that the same registry still lists the two
decommissioned llama ids — it is stale in both directions, so the
provider's catalogue is the authority for what's live and the registry
only for what the SDK can build.

**PAT embedded in the remote URL.** `authedRemote()` puts the GitHub
token in the remote URL, so it lands in `.git/config` on the runtime
disk. Fine for a take-home on an ephemeral container; a credential
helper or a short-lived GitHub App token belongs there in production.

**Script-hook stdin schema is an educated guess.** GitAgent documents
the *programmatic* hook context precisely (`ctx.toolName`, `ctx.args`)
but is less explicit about the JSON passed to *script* hooks, so
`agent/hooks/guard-branch.sh` defensively reads `toolName`, `tool` and
`tool_name`. This is why the same guard also exists programmatically in
`agentRunner.ts`, where the shape is typed and certain — the shell
version is a backstop for bare-CLI use, not the primary enforcement.

**Archived transcripts accumulate on `main`.** Every decided proposal
leaves a JSON file in `agent/proposals/`. That's the point — it's the
audit trail the `compliance` block claims — but nothing prunes it, and
at a few thousand proposals the directory wants a year-partitioned
layout and the recovery scan wants an index.

**Polling, not streaming.** The client polls every 1.5s while a run is
in flight. SSE would be tidier; the agent's status is coarse enough
(one label, elapsed time) that polling costs nothing an analyst can
perceive. Streaming *tokens* I'd still leave out — you read the
backtest before you act, so honest status beats watching text land.

**The `agent/.gitignore` fix is a bandage on someone else's design.**
The SDK writing mutable state into the working directory it operates on
is the actual problem; ignoring the file is what I can do from outside
it. If `.gitagent/` ever holds something worth keeping, this silently
discards it.

**No auth.** Anyone with the URL is "the analyst", which is obviously
wrong for a tool that edits fraud policy. It's the only item here I'd
call a blocker for anything real.

---

## Deliberate cuts

- **No auto-merge, ever.** There is no configuration for it and I
  didn't build one. A system whose value is "a human reviewed this"
  shouldn't ship a switch that turns that off.
- **Synthetic data only.** `agent/data/` is generated by
  `scripts/gen_transactions.py` with a fixed seed, and fraud correlates
  *imperfectly* with the signals on purpose. The live ruleset catches
  32.7% of fraud at an 11.1% false-positive rate — a clean 100% would
  make the backtest look impressive and mean nothing.
- **No streaming of model output.** See above.
- **Left the workbench out of GitAgent's own voice/web UI at :3333.**
  The harness ships one. Using it would have satisfied "it runs on
  GitAgent" while failing the actual brief, which asks for an operating
  surface rather than a chat box.

---

## Calls worth defending

**Squash-merge instead of a merge commit.** One approved proposal = one
commit on `main`, whatever the agent's iteration history looked like.
`git log` on the ruleset reads as a policy changelog rather than a
transcript of false starts, and revert is trivially one commit. The
cost is that iteration history dies with the branch — though since the
conversation is now committed to the branch and archived on `main` at
decision time, what's actually lost is only the intermediate file
states, not the reasoning. I'd still reverse it if a team wanted to
audit *how* the agent got somewhere rather than where it landed.

**The conversation is a committed file, not server state.** Turns are
written to `agent/proposals/<branch>.json` in the same commit as the
rule edit. It survives a restart, it diffs, and on a decision it's
stamped approved/rejected and archived onto `main` beside the change it
argued for. Rejected conversations are archived too — otherwise the
agent can read that something was rejected but never what it argued.

**The analyst is never blocked from merging, but the button tells the
truth.** A proposal with no backtest, no `COMMIT_MSG`, and files
touched outside the ruleset can still be merged — the human holds the
authority, and a tool that overrides them is a different product. What
changes is the affordance: it loses the green, reads "Merge anyway",
and the line above names what was broken.

**A failed run offers no Approve or Reject at all.** Recording a
rejection for a branch the agent never wrote to would put a decision in
the agent's memory that the analyst never made — and that memory is
read back before every future draft. A lie in the record is worse than
a missing one. It offers Discard, which leaves no trace because nothing
happened.

**A proposal recovered without its transcript is still decidable.** The
conversation is gone; the diff isn't. That's the whole argument for
keeping state in git rather than in the server, so the UI honours it.

**The left pane shows thresholds, not just descriptions.** Rule prose
drifts from the condition. Immediately after merging a threshold change
in testing, the live pane read "over ₹50,000" for a rule that now fired
at 25,000. The condition is rendered underneath, in file order.

**`compliance.human_in_the_loop: true` in `agent.yaml` is a claim the
code honours.** `DUTIES.md` spells out who holds which authority, and
`agent.yaml`'s tool list now matches what the server actually permits —
which it didn't, before the audit above.

---

## With a full week

1. Real timestamp-window evaluation in the backtest, killing the
   10-minute approximation.
2. A branch-comparison view: two competing proposals for the same
   incident, backtested side by side, analyst picks one. The git model
   supports this completely — it's purely UI.
3. Shadow mode: merge a rule to a `shadow` branch that scores live
   traffic without acting, promote to `main` after N days of real data.
   This is the feature the git-native design most obviously wants and
   the one I'd most want to build.
4. Auth, and a per-analyst identity on commits so `git blame` on the
   ruleset names a person.
5. A paid provider tier, and a queue in front of the agent so
   concurrent proposals don't rate-limit each other.
