# Cost-aware routing: coder tiers, card size and one-step escalation

Status: done
Updated: 2026-11-04

Epic: BI-114.

## Goal

Every card goes to the cheapest coder that can do it. The board has coders of three tiers —
Fast, Standard and Strong, each a model plus an effort — and the Architect sizes each card
S / M / L and routes it to the matching tier. A card the cheap coder cannot finish costs one
step up, not a Strong model on everything: when the board's check fails a second time the card
moves to the next tier up, once. The owner pays for Opus where Opus is needed, and for Haiku
everywhere else.

Done when: coders carry a tier with a model and an effort; dispatch routes by card size and
stores the size on the card; a failed check retry escalates one tier; a board can run
with a Fast, a Standard and a Strong coder; the tier mapping, the routing and the escalation
are covered by tests; typecheck, lint and test are green.

## How it is built

- **Tier on the agent.** `members.tier` (`fast | standard | strong`), next to `effort` and
  `max_turns` in `src/server/db.ts`. Coders only — an architect is `NULL`: it routes the work, it
  is not a tier. The type and the list are `AgentTier` / `AGENT_TIERS` in `src/lib/types.ts`.
- **Effort → tier.** `tierForEffort` in `src/lib/tiers.ts` is the one place the mapping lives:
  low → fast, medium → standard, high or max → strong, none → standard. The migration fills
  every coder whose tier is `NULL` with it on each open; the store uses it for a coder that just
  switched over from architect; `tests/store-tiers.test.mjs` tests it. A new coder is Standard.
- **Per-tier defaults.** `TIER_DEFAULTS` in `src/lib/tiers.ts`, one table per engine:

  | Tier | Claude Code | Codex CLI | Effort |
  | --- | --- | --- | --- |
  | Fast | `haiku` | `gpt-6-luna` | low |
  | Standard | `sonnet` | `gpt-6.1-sol` | medium |
  | Strong | `opus` | `gpt-6-astra` | high |

  They are only what the Agents page fills in when a tier is picked; the agent's own model and
  effort are what the worker runs, and both stay editable.
- **Agents page.** A *Tier* select on coder agents (`AgentEditModal` in
  `src/components/kanban-app.tsx`); picking one sets Model and Effort from the table for the
  agent's engine. A new coder opens with Standard's model and effort filled in; when Model or
  Effort differ from the tier's defaults, *Use defaults* next to the select fills both. On an
  engine switch the model follows only if it still is the old engine's default for the tier —
  a model typed by hand stays. The agent card and the New board agent list show the tier first in the
  config line (`agentConfigLabel`). `POST /api/agents` and `PATCH /api/agents/:id` take and
  return `tier`; anything but the three names is a 400 (`cleanAgentConfig` in the store).
- **The prompts see it.** `memberLine` in `agents/lib.mjs` puts `<tier> tier` into each agent's
  line of the participants list, next to engine, model and effort — what the Architect will
  route by in item 2.
- **A model the CLI rejects fails the run.** `modelRejection` in `agents/lib.mjs` recognises
  the CLIs' "no such model" wording; `claudeFailure` (`agents/adapters/claude.mjs`) and
  `codexFailure` (`agents/adapters/codex.mjs`) turn it into "Claude Code rejected model x — pick
  another on the Agents page" / "Codex rejected model x — …", also as the owner's `In short:`
  line. Never a silent retry on the default model: that would bill a different tier than the
  one on the card. For Codex only its own last `ERROR: …` line counts: the rest of `codex
  exec` output is the agent's activity, which may quote a rejection (this repo's tests do).
  Cases in `agents/claude-failure.test.mjs`.
- **Routing rules.** `agents/prompts/dispatch.md`, for every board: the Architect sizes each
  Ready card — S (copy, styling, a small fix in one or two files, nothing to decide), M (a normal
  feature in a few files), L (cross-cutting, new architecture, unclear scope, risky) — and gives
  it to the cheapest tier that can do it: S → Fast, M → Standard, L → Strong; no coder of that
  tier → the next one up; none at or above → the highest the board has, said in the note. Never a
  dearer coder because the cheaper one has a queue. The owner's tag on a card stands. The chat
  note is one line per card: `BI-12 → @handle · S · one-line copy change`.
- **Size on the card.** The decision carries `"size": {"<card id>": "S"|"M"|"L"}`. `parseReply`
  (`agents/lib.mjs`) reads it in any case into `decision.size`; a bad value is dropped and named in
  `problem` while the rest applies, and a decision of sizes alone is valid. `applyDispatch`
  (`src/server/store.ts`) stores it in `tasks.size` (`NULL` for older cards), resolving `BI-12`
  refs like `assign` and reporting cards not in Ready in `unresolved`; a card the decision does not
  size keeps the one it had. `Task.size` / `QueueCard.size` (`src/lib/types.ts`) — the queue the
  Architect reads says `sized M` for a card it already sized. The board shows a small S/M/L badge
  after the card number, on the card and in the card panel. `agents/lib.test.mjs`,
  `tests/store-dispatch-size.test.mjs`.
- **Escalation.** `reportCheck` (`src/server/store.ts`): the second failure of a Fast or Standard
  coder, on a card with `tasks.escalated_at` still `NULL`, on a board with an Architect and a
  coder above (`nextTierUp` in `src/lib/tiers.ts` — the closest higher tier present), queues an
  Architect run `escalate:<messageId>`; the system line says *<Architect> is looking at whether a
  Standard coder should take it over*. Otherwise "a human needs to look", as before. The Architect
  gets `agents/prompts/escalate.md` and answers `{"escalate": "<handle>", "reason": "…"}`
  (`parseEscalate` in `agents/lib.mjs`) or `needs: owner`. The worker posts it to
  `POST /api/tasks/:id/escalate`; `escalateTask` checks Architect, In progress, the escalate run
  being newer than the last coder run, once per card and the exact next tier — a refusal goes into
  the chat. Accepted: the coder tag swaps, *Old (Fast) → New (Standard): reason*, `escalated_at`
  is set and the new coder gets an `escalate:` run (its own prompt line: start from the working
  tree). `tests/store-escalation.test.mjs`, `agents/lib.test.mjs`.
- **Escalation, the edges.** The Architect's reply on an `escalate:` run is posted with
  `participant: false` (like a dispatch note), so a handle in it wakes no coder ahead of the swap;
  the prompt keeps handles out of the text anyway. `escalateTask` refuses while the card waits
  for the owner — no run could be queued, and the one escalation would be spent. Notifications:
  the `check_failed` event of a failed retry that the Architect takes carries
  `escalating: true`; `classify` in `agents/notify.mjs` sends nothing for it and resets the
  card's failure count, so the new coder's first failure is routine and its second is
  "Check failed again", as for any card. `agents/notify.test.mjs`.
  Only the *Architect's* `escalate:` reply is quiet: the new coder's first run carries the same
  trigger, and its "@architect …?" must still wake whom it names. And since the failed retry no
  longer reaches the owner, an Architect `escalate:` run that ends with no accepted escalate and no
  accepted `needs_owner` (the board refused the tier, or the reply had no action) flags the card
  for the owner itself — reason `question`, the refusal as the text. `agents/worker.test.mjs`.
  That flag carries the Architect's `In short:` line only when the reply had no ACTIONS line at
  all; beside a refused or unreadable action the line was written for a hand-off that never
  happened, so it is left out. Switching the Architect off mid-escalation (`cancelArchitectRuns`)
  flags every card whose Architect `escalate:` run is queued or running and has not landed —
  reason `question`, "switched off before it decided" — since a switched-off Architect can
  neither swap the coder nor flag the card. `tests/store-escalation.test.mjs`.
- Decision: `docs/decisions.md`, 2026-11-03 — a tier is a model plus an effort; a card's size is
  set at dispatch and the tier follows from it; a failed retry escalates one step.

### Which model names the CLIs accept (checked 2026-11-03)

- **Claude Code** (the `claude` on this machine): `claude --help` documents `--model` as "an
  alias for the latest model (e.g. 'fable', 'opus', or 'sonnet') or a model's full name";
  `haiku` is the alias for the small family. Aliases follow the newest release, so the table
  does not go stale with each model. Not probed with a call.
- **Codex CLI** (0.160.0, the Homebrew one on PATH that the worker runs): `~/.codex/models_cache.json`, the model list the CLI itself fetched
  (2026-11-03), lists `gpt-6.1-sol` ("Latest workhorse model for coding and everyday work",
  priority 1, also the `model` in `~/.codex/config.toml`), `gpt-6-astra` ("Frontier
  intelligence for the most demanding work"), `gpt-6.1-terra`, `gpt-6-sol`, `gpt-6-luna` ("Fast
  and affordable model for easier tasks"), `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`; and,
  hidden from the picker, `gpt-reserve` and `codex-auto-review`. Not probed with a call.

## Subtasks

- [x] 1. Coder tier with a model and an effort per tier (BI-114 points 1, 6) — `members.tier`
  with the effort migration, per-engine defaults, the Tier select, tier in the routes and in
  `memberLine`, a rejected model named in the failure; effort → tier and the store round-trip
  tested.
- [x] 2. Routing rules in `dispatch.md` and an S/M/L size stored on each card (points 2, 3) —
  the Architect sizes every Ready card and routes it to the matching tier; tests.
- [x] 3. One-step escalation when the check retry fails (point 4) — the card goes to the next
  tier up, once; tests.
- [x] 4. A board set up with a Fast, a Standard and a Strong coder (point 7).

Tests (point 5) go with items 1–3.

## Open questions

- The next tier up has no coder on the board — item 3 escalates to the closest higher tier
  that has one (done: `nextTierUp`).
- No coder sits at or above a card's tier — item 2 gives it to the highest tier there is
  (done: `dispatch.md`).
