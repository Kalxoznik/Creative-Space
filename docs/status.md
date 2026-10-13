# Status

Updated: 2026-10-13

The current state of the project in one place. Whoever changes that state updates this
file in the same change — short lines, no history (history lives in `decisions.md` and
in git).

## Works

- **Board UI** (`src/components/kanban-app.tsx`) — columns, drag and drop between them
  (dnd-kit), renaming and reordering columns, panning a wide board, a card panel with
  description, chat, participants and Stop, board menu with details, archiving Done cards
  and restoring them from *Archived*. The header has no worker-status pill; worker status
  remains available in the Agents view, reached from the sidebar.
- **Rich-text keys** — repeated mentions across inline images in card descriptions and chat
  have unique React keys, scoped by each text chunk's source offset.
- **Store and API** — all rules live in `src/server/store.ts` over `data/board.db`
  (`node:sqlite`, no native deps, schema and migrations in `src/server/db.ts` — every open of
  the file runs them, the version stamp does not gate them, `tests/db-migrate.test.mjs`);
  `src/app/api/*` is a thin HTTP layer, `GET /api/events` streams changes over SSE and the UI
  refetches on each one (the worker does not listen to SSE — it polls).
- **Event feed** — the board also stores what happened: one numbered line per card move, run
  (started / finished / failed / waiting), check, commit and chain pause, in the `events` table
  (`src/server/feed.ts`, 30 days). `GET /api/events?board=<key|id>&since=<id>&limit=<n>` reads
  it back oldest-first with a `cursor` for the next call — for an architect in the owner's chat
  and for notifications, which cannot watch the SSE stream. A line also carries the card's title,
  shortened, so a client can name the card without a second request; `GET /api/boards` is the
  same kind of read for the boards themselves — their settings, without the cards.
- **Notifications to the owner** — the worker reads the event feed and tells the owner about the
  eight things that need a human: a card in Review, a card in **Done** (whoever moved it there),
  `needs_owner`, an agent tagging the owner by handle (`owner_mentioned`, labelled "Question"),
  a failed run (except the one the board continues itself — see *the turn limit* below), a second
  failing
  check in a row on one card, `agents_paused`, `commit_skipped` (`agents/notify.mjs`). macOS
  (`osascript`) whenever the worker runs on a Mac, Telegram when `TELEGRAM_BOT_TOKEN` and
  `TELEGRAM_CHAT_ID` are in the environment or in the git-ignored `.env` — no token, no channel,
  one line about it at start, and the token never reaches a log. The text is `BI-69 — Review:
  <title>`, then — when the agent wrote one — **its own line about what happened** in the owner's
  language; never chat, log or diff. The two channels differ in what they add to that: macOS
  notifies next to the board and keeps the link to the card (`/?task=<id>`), **Telegram carries no
  link at all** — it is read on a phone, where `localhost` opens nothing — and a card reaching
  **Done** is one standard line there, `BI-79 moved to Done`, with no title, no agent's line and
  no link, whoever moved it. That line is
  the `In short: …` the role prompts ask for at the end of a hand-off, a question to the owner or
  a failure: the parser lifts it out of the reply (`plainLine` in `agents/lib.mjs`), the worker
  passes it with the move / `needs_owner` / `finishRun`, and the board keeps it on the event as
  `plain` (300 characters, inside the event's `data`, `src/server/feed.ts`). At most one
  notification per card per 2 minutes, the rest glued into it as `+N`. Off per board with
  *Notify me* in the board's details (`boards.notifications_enabled`, on by default); the agent's
  line alone off with *Detailed notifications* next to it (`boards.notifications_detailed`, on by
  default) — for a board whose text must not leave the machine. Nothing that happened before the
  worker started is ever announced.
- **The Telegram bot both ways** — the worker also *reads* the bot, with `getUpdates` long polling
  in a loop of its own (`agents/telegram.mjs`): no webhook, no port open, no tunnel. Every
  notification about a card stores its Telegram `message_id → task_id`
  (`telegram_notifications`, 30 days, `/api/telegram/notifications`), so **replying** to a
  notification puts that text in the card's chat as a message from the owner with
  `source = "telegram"` (a small label in the chat), and the board's own rules take it from there
  — untagged to the architect, a tag to whoever it names. A message does not have to be a reply:
  a card number in the text ("BI-69 to Done", any case) addresses that card, and with neither a
  reply nor a number the text goes to the card of the **last notification the bot sent**, while
  it is less than a day old. Delivery itself is **silent** — the confirmation is the agent's own
  answer coming back (below), and a wrong guess at the card shows up in that answer not matching
  what was asked. The bot writes only failures (a number no card has, a reply it cannot place, a
  board that will not take it — one short line, no details) and one case where nothing will
  answer: the board woke nobody (`woke: []` on the posted message), which reads
  `Saved to UG-3. Agents on this board don't answer on their own.`
  `/status` answers with In progress, Review and "Waiting for the owner" per board (numbers
  and titles only); an unknown `/command`, or a loose message with no fresh notification to
  attach to, gets a hint. Only `TELEGRAM_CHAT_ID` is listened to — another
  chat gets no answer and one log line without its text; updates waiting from before the worker
  started are dropped, and the token stays out of every log and error.
- **The agent's answer comes back to Telegram** — a message the bot files carries the owner's own
  Telegram `message_id` (`messages.telegram_message_id`), and when the agent that message woke
  answers on the card, the board records an `agent_answered` feed line and the notifier sends
  `BI-79 · <the agent's words>` **as a reply to that message** (`agents/notify.mjs`). The text is
  the agent's `In short:` line, or its prose with the code, the fences and the paths taken out, to
  600 characters. Exactly one answer per message of theirs
  (`messages.telegram_answered_at`) — the agents' further talk on the card, and answers to
  messages typed on the board, stay on the board. A board with *Detailed notifications* off gets
  `UG-3 · Agent replied in the card chat` and nothing of the corpus. The answer is never held in
  the two-minute window and never glued, and it is remembered against its card like any other
  notification, so the owner can reply to it. `tests/store-telegram.test.mjs`,
  `agents/notify.test.mjs`.
- **One reaction: 👍 = "done, into Done"** — `REACTIONS = ["👍"]` (`src/lib/types.ts`). Stored per
  (message, member, emoji) in `message_reactions` and handed out with the card's messages
  (`GET /api/tasks/:id` and `…/messages`); `POST` / `DELETE /api/tasks/:id/reactions` puts one on
  and takes it off, and the feed gets `reaction_added` / `reaction_removed` — never notified
  about. Only the **owner's** 👍 does anything, and only on a card in **Review**
  (`addReaction` in `src/server/store.ts`): the board moves the card to Done itself, no run.
  Anywhere else it is a mark on a message. A 👍 carries the weight of a message from Telegram —
  enough to move a card, never enough for a paid call, a corpus write or a deploy (both role
  prompts say so); a question of an agent's the owner answers in words.
  In Telegram: every notification also remembers *which message on the board* it is about
  (`telegram_notifications.board_message_id` — the question for a "Question", otherwise the card's
  last `In short:` message), so the owner's 👍 **on the notification** becomes a 👍 on that message,
  or on the card when there is none. `getUpdates` asks for `message_reaction` explicitly, and
  where Telegram does not deliver reactions a **reply that is just 👍** counts as the same thing.
  The bot is quiet when the card moved and says
  `BI-70 is not in Review yet, so it is not moved to Done. Say it in words.` when it did not.
  There is no reaction picker in the chat UI yet.
  `tests/store-reactions.test.mjs`, `agents/telegram.test.mjs`.
- **Launch** — `npm run up` starts the board and the worker together on port 43123 and one
  Ctrl+C stops both; first launch seeds an owner, an Architect, a Coder and the example board.
  The board (`npm run up`, `dev`, `start`) listens on 127.0.0.1 only; `HOST` opens it wider.
- **Agent worker** (`agents/worker.mjs`) — polls `/api/agents/claim` per agent, runs it
  through its engine's adapter (`stub`, `claude`, `codex`), streams the run log, posts the
  reply as the agent, applies the `ACTIONS: {…}` line (`move`, `create`, `needs: "owner"`, and
  `assign` / `order` / `blocked_by` on a dispatch run), heartbeats every 5 s with the CLIs
  it found, and honours Stop and the run timeout.
- **Queue and dispatch** — a card entering Ready wakes the Architect, which assigns a coder,
  orders the queue and sets blockers (`agents/prompts/dispatch.md`); coders take their cards
  one at a time and never run together on one repository.
- **One card at a time** — on by default for new and existing boards (`boards.one_card_at_a_time`,
  a switch in the board's details): while any card is in In progress or Review, Ready stands
  still — no coder takes a card and no dispatch is queued, and the Ready cards say *Waiting for
  the current card*. The card in Review holds the queue until the owner moves it to Done (back to
  In progress = more work on the same card); then the next Ready card starts by itself, or — on a
  board with an architect, when nothing there is a coder's yet — the dispatch is queued then
  (`queueHeld` / `dispatchWaitingReady` in `src/server/store.ts`, `tests/store-one-card.test.mjs`).
  Off = the queue as before: a coder that hands off takes the next card at once.
- **What a mention wakes** — `@handle` in a chat message starts a run for that agent, but only
  where it is addressed to somebody: a handle inside backticks, a ``` block or a quoted line
  (`>`) wakes nobody, and an agent naming an agent on a card already in Review or Done starts
  nothing either (a human's mention there still does). `triggerMentions` / `addressedText` in
  `src/server/store.ts`.
- **A tag on the owner is a question** — the same addressed part naming the owner's handle, from
  anybody but the owner, records `owner_mentioned` in the feed and notifies as "Question" with the
  author's `In short:` line (or the first 200 characters without code, `askedLine` in
  `src/lib/plain-text.ts`). Nothing else about a card's chat reaches the phone, so both role
  prompts reserve the `@` for a question or a decision and name the owner without it everywhere
  else. `tests/store-owner-mentioned.test.mjs`.
- **An untagged message of the owner** — goes to the board's architect by default: no handle in
  the addressed part and the author is the owner → one architect run with trigger
  `owner:<messageId>`, the busy rules of a human's mention. In that run, and only there, the
  architect may move the card to **Done** on the owner's direct request (`agents/lib.mjs`
  refuses `"move": "done"` from an architect in any other run). With the architect switched off
  nothing runs and the feed gets an `owner_message` line — ref, author, message id, no text —
  for the architect outside the board.
- **Where a card lives while it is worked on** — In progress, from the moment a coder takes it
  until the Architect's review passes; the review runs on the card in In progress and only the
  Architect's verdict moves it to Review, which starts nothing and is the owner's final look
  (`REVIEW_TRIGGER` / `awaitingReview` in `src/server/store.ts`).
- **Check and commit** — the board runs the board's check command before a coder's hand-off
  to Review; on success it commits only the paths the work on that card changed
  (`agents/git.mjs`), never pushes and never rewrites history. The "before" snapshot belongs to
  the card (`tasks.work_snapshot`, `POST /api/tasks/:id/snapshot`), so work done in one run and
  handed off in another lands in one commit; a commit git refuses keeps the card in In progress
  with a system message, a hand-off whose work changed no file goes on to the review with *No
  file changes in this run — nothing to commit.* in the chat (no notification), and a commit
  that lands says its sha and files there. The commit's subject is the coder's own English line
  (`"commit"` in its ACTIONS, at most 72 characters); without one it is the card's title, as
  before. Body: the task id and the agent.
- **A board without an architect** — *Architect: off* in the board's details
  (`boards.architect_enabled`): Ready goes straight to the card's coder with no dispatch, a
  coder that finishes puts its card in Review itself once the check is green, and `@architect`
  starts nothing there. For a board somebody plans and reviews from the outside; other boards
  are unaffected. A second human for that outside reviewer is `POST /api/members` —
  `docs/people.md`.
- **Card digest** — `GET /api/tasks/:id/digest` answers with the card in one short read: ref,
  column, assignees, the last run, the latest check (verdict, exit code, last 40 lines of output
  without ANSI), the last commit (sha and files) and the last 3 messages, shortened. Derived
  from the run logs and the chat, read-only — for an architect that reviews the board from
  outside and would otherwise pull the full logs (`src/server/digest.ts`).
- **Waiting for the owner** — an agent can park a card on the owner's word with
  `ACTIONS: {"needs": "owner", "reason": "paid_call|corpus_write|deploy|question", "text": "…"}`
  (`agents/prompts/coder.md` says when). The card does not move, gets a **Needs owner** badge
  and a `needs_owner` line in the feed, and while the flag is on nothing wakes an agent there:
  the runs queued on it are cancelled, an agent's mention starts nothing and the queue leaves
  it alone. A human's message in the chat takes the flag off — or the × on the badge in the
  card panel (`setNeedsOwner` / `clearNeedsOwner`, `POST|DELETE /api/tasks/:id/needs-owner`).
  The flag holds the card, not the agent: a parked card in In progress releases its coder the
  way a card awaiting review does, so the coder goes on with Ready while the question waits,
  and the owner's answer joins its run queue (`coderBusyReason`) — with *one card at a time*
  off; with it on, the parked card holds Ready like any card in In progress.
- **A run always ends** — the worker closes the run on the board before it writes anything in
  the card's chat, and every reporting step of a finishing run (reply, check note, commit note,
  the card's move) is tolerated on its own: what the board refused goes into the run's summary,
  along with the commit sha. If the worker itself goes away, the board closes the run:
  `running` with no report for longer than the run timeout + 5 min becomes `failed` with "The
  worker lost the run" and a system message (`sweepLostRuns`, `agent_runs.heartbeat_at`).
- **A failure says what it was, and the turn limit continues itself** — `claude -p` spreads the
  reason over `result`, `errors[]` and `subtype`, and a run that ran out of turns writes only the
  last two, so it used to be reported as "unknown error" (`claudeFailure` in
  `agents/adapters/claude.mjs` now reads all three; the owner's line says "Hit the turn limit
  (80). The work is left in the working tree."). When that happens to a coder and the work on the card
  changed something in the checkout, the worker says so when closing the run (`turnLimit`) and the
  board gives the same agent **one** more run on the same card — trigger `continue:<messageId>`,
  a system message in the chat, no notification: continue from the working tree, revert nothing,
  hand the card to Review (`continueAfterTurnLimit` in `src/server/store.ts`). One per stint in
  In progress; the second limit in a row is a plain failure the owner hears about.
- **Migrations under a running dev server** — the schema version lives in the file
  (`PRAGMA user_version`), so a reloaded module catches the database up and never stamps it
  backwards; a query that still hits a missing column answers 503 "restart the board" instead
  of a raw SQLite 500.
- **Card numbers** — boards have a key and a counter, so a card is `BI-50` in chats and
  prompts as well as `t_…` in the API (`src/server/board-key.ts`, `src/lib/task-ref.ts`).
- **One run per agent per card** — a trigger arriving while that agent already has a run on the
  card (queued, or in flight) does not stack a second one; only a human's message interrupts a
  run in flight, and a dispatch note wakes nobody it names (`enqueueRun` in
  `src/server/store.ts`).
- **Tests** — `npm test` covers the ACTIONS parser, the commit step against a real throwaway
  repository, the worker's failure reporting (`agents/worker.test.mjs`, against a stubbed
  board), the store's run queue, the architect switch, the card digest, the event feed, the
  lost-run watchdog, the "waiting for the owner" flag and the owner's notifications
  (`agents/notify.test.mjs`: the rules, the glue, a missing token, what the text may say) and the
  bot's inbound half (`agents/telegram.test.mjs`: the chat-id filter, where a reply, a card
  number and a loose message each go, the day-old cut-off, `/status`, unknown text, the token
  never in a log; `tests/store-telegram.test.mjs`: the notification → card link, the lookup by
  number, the last notification and `source = "telegram"`), the turn limit
  (`agents/claude-failure.test.mjs` for the reason, `agents/worker.test.mjs` for the dirty-tree
  condition, `tests/store-turn-limit.test.mjs` for the one continuation)
  (`tests/*.test.mjs` import
  `src/server/store.ts` directly against a throwaway database). `npm run typecheck` and `npm run lint` are green.

## Broken / known issues

- **`npm audit` is not clean (10: 9 high, 1 critical).** The critical one is Next.js 16.3.4;
  the fix is 16.4.0, outside the exact pin, so it waits for a deliberate upgrade. The high ones
  are all `braces` (no patched version) under dev-only tooling — `eslint-config-next` and the
  `shadcn` CLI — and never run in the board itself.
- **`src/` is barely tested.** Only the store's run queue (`tests/store-runs.test.mjs`), the
  architect switch (`tests/store-architect-off.test.mjs`), the card digest
  (`tests/digest.test.mjs`), the event feed (`tests/feed.test.mjs`), the lost-run watchdog
  (`tests/store-lost-run.test.mjs`) and the "waiting for the owner" flag
  (`tests/store-needs-owner.test.mjs`), the untagged owner message
  (`tests/store-owner-message.test.mjs`), the Telegram notification links and a message's
  `source` (`tests/store-telegram.test.mjs`) and the schema catch-up
  (`tests/db-migrate.test.mjs`) have tests; for the UI,
  the rest of the store and the API routes `typecheck` + `lint` are the whole gate.
- **Agent threads stop themselves.** After six agent messages in a row a card's chat pauses
  until a human writes (`MAX_AGENT_CHAIN` in `src/server/store.ts`) — the agents go quiet,
  which looks like a hang.
- **Every Ready move costs a model call.** On a board with an Architect, dispatch is a run of
  its own before the coder's — *Architect: off* is the way out when something else plans the
  board.
- **A second human has no UI.** Adding one (an outside architect in the owner's chat) is a
  `POST /api/members` by hand; the board's details only let you take them off a board, not
  put them on it.
- **A card created by an agent cannot create more cards** — deliberate, but it means a
  decomposition is one level deep.

## Next

- `docs/features/` does not exist yet (git does not keep empty folders): the first real feature
  to be planned this way gets its own file from
  `templates/project-docs/docs/features/_template.md`.

## Not doing (for now)

- Accounts, auth, hosting: everything runs locally against one SQLite file by design.
- Calling model APIs with keys — agents run on the Claude Code / Codex CLI and the user's own
  subscription.
- Pushing to a remote or rewriting history from the board.
