# Status

Updated: 2026-11-04

The current state of the project in one place. Whoever changes that state updates this
file in the same change — short lines, no history (history lives in `decisions.md` and
in git).

## Works

- **Browser tab activity** — the current board's running agent tasks show a green favicon,
  including while a card is open. Existing initial loading and SSE updates drive it;
  the favicon restores when the board is idle. The tab title stays unchanged.

- **Board UI** (`src/components/kanban-app.tsx`) — columns, drag and drop between them
  (dnd-kit), renaming and reordering columns, panning a wide board, a card panel with
  description, chat, participants and Stop, board menu with details (a ⋮ next to the header
  breadcrumb and in the sidebar; ⌘, opens Board details), archiving Done cards
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
  `TELEGRAM_CHAT_ID` are in the environment or in the git-ignored `.env` for terminal/dev runs.
  The Mac app (packaged and `npm run app`) ignores both sources: Telegram starts off until
  connected in Workspace settings → Notifications. The bot token and numeric chat ID live only
  in `telegram.json` under Electron's app data folder, atomically saved with mode 0600; the
  settings API never returns the token. Connect, replace and disconnect apply within a worker
  tick to both notifications and replies; disconnect deletes the credentials. macOS remains
  independent. Missing or invalid app settings leave Telegram off. No token, no channel,
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
  `assign` / `order` / `blocked_by` / `size` on a dispatch run), heartbeats every 5 s with the CLIs
  it found, and honours Stop and the run timeout. The timeout is the agent's own
  (`members.run_timeout_minutes`, *Timeout, min* in the agent editor, 5–180) or `CS_RUN_TIMEOUT_MS`
  (20 min) when unset; a run killed at it is closed as `timeout` — not `failed` — with "Stopped by
  the run timeout (N min). The working tree is kept; mention the agent to continue." in the chat,
  no CLI output, and a "Run timed out" notification.
- **Coder tiers** — every coder is Fast, Standard or Strong (`members.tier`; existing coders
  got theirs from their effort, architects have none). The agent editor's *Tier* select fills
  Model and Effort from per-engine defaults (`src/lib/tiers.ts`), the agent card and the New board
  list show it, the routes take it, and the prompts' participants list names it. A model the CLI
  rejects fails the run with "<engine> rejected model x — pick another on the Agents page".
  `tests/store-tiers.test.mjs`, `agents/claude-failure.test.mjs`.
- **One architect per board** — Board details and New board choose `boards.architect_id`;
  existing boards keep their previous architect. Dispatch, review, supervision, escalation,
  owner messages and queue release use that selection. Only the owner is pinned globally;
  the selected architect is always a member, other architects can join for mentions. Agents
  lists each architect's boards, and prompts name the board's architect. Separate architects
  run concurrently on different boards. Selection changes transfer queued duties; deletion
  (or a role change) falls back to another architect, or Architect-off behavior, with system
  messages only on Ready/In progress cards and cards with transferred or cancelled queued runs.
  Consulting architects create unchained Backlog cards; only the selected architect can create
  Ready cards or chain follow-ups. A running architect finishes before its selection can change.
  `docs/features/board-architect.md`, `tests/store-board-architect.test.mjs`.
- **Queue and dispatch** — a card entering Ready wakes the Architect, which sizes every Ready
  card S / M / L, gives each to the cheapest coder tier that can do it (S → Fast, M → Standard,
  L → Strong, the next tier up when one is missing; the owner's tags stand), orders the queue
  and sets blockers (`agents/prompts/dispatch.md`); coders take their cards one at a time and
  never run together on one repository. The size is stored on the card (`tasks.size`) and shown
  as a badge after its number. `tests/store-dispatch-size.test.mjs`, `agents/lib.test.mjs`.
- **One-step escalation** — a Fast or Standard coder whose check fails after its one retry no
  longer goes straight to the owner: the Architect gets an `escalate:` run
  (`agents/prompts/escalate.md`) and either hands the card to a coder of the closest higher tier
  on the board (`{"escalate": "<handle>"}` — the tag swaps, *Old (Fast) → New (Standard): why*,
  the new coder's run starts on the same working tree) or asks the owner. Once per card
  (`tasks.escalated_at`); a Strong coder, a card that went up already, no higher-tier coder or no
  Architect → the owner, as before. The store refuses any other escalation and the refusal is
  posted in the chat. The check retry is now counted from the run that reports it, so a coder gets
  exactly one. `tests/store-escalation.test.mjs`, `agents/lib.test.mjs`.
- **The Architect supervises stuck cards** — a coder's run that failed, ran out of turns (past
  its one continuation), was stopped as a loop, timed out or was lost; a check that failed after
  its retry with no tier to go up to; or a coder that stopped without a hand-off and without
  tagging a human — each wakes the board's Architect once (`supervise:<runId>:<reason>`, with the
  run's log tail in its prompt, `agents/prompts/supervise.md`). It gives the coder a hint by
  mention, hands the card to another coder (`{"reassign": "<handle>"}`, `POST
  /api/tasks/:id/reassign`), splits it, or asks the owner; a reply that decides nothing goes to
  the owner. At most 2 per card (`tasks.supervisions`, shown in the card's *Agent runs*); the
  third time the card goes to the owner by itself. Done, Backlog or a human's answer starts the
  count over. The owner is not notified of a failure the Architect is looking at.
  `tests/store-supervise.test.mjs`.
- **Autopilot** — a switch in board details (`boards.autopilot`, off by default; the header says
  *Autopilot* when on). On, the Architect's approval of a hand-off takes the card to Done instead
  of Review; off, it waits in Review for the owner as before. Only the hand-off review's verdict
  counts (also when it comes from the `reply:` wake of a fix round, with the review still
  queued) — an Architect move to Review with no hand-off pending stays in Review. The owner's Done
  notification then carries the title and the Architect's *In short* line, as Review's would.
- **One card at a time** — on by default for new and existing boards (`boards.one_card_at_a_time`,
  a switch in the board's details): while any card with an agent among its assignees is in In
  progress or Review (cards of people only run alongside and never hold it), Ready stands
  still — no coder takes a card and no dispatch is queued, and the Ready cards say *Waiting for
  the current card*. The card in Review holds the queue until the owner moves it to Done (back to
  In progress = more work on the same card); then the next Ready card starts by itself, or — on a
  board with an architect, when nothing there is a coder's yet — the dispatch is queued then
  (`queueHeld` / `dispatchWaitingReady` in `src/server/store.ts`, `tests/store-one-card.test.mjs`).
  Off = the queue as before: a coder that hands off takes the next card at once.
  *Next card starts after* (`boards.queue_release`, shown under the switch): *Owner moves it to
  Done* (default) or *Architect approves it (Review)* — then only In progress holds the queue, the
  Architect's move to Review starts the next card (*Previous card is in Review — …*), and finished
  cards pile up in Review for the owner; a card dragged back to In progress holds it again.
- **Archiving a board** — *Archive* in the board menu (sidebar or header ⋮; not shown for an archived board) (`boards.archived`): the board
  leaves *Your boards* and shows under *Archive* with a semibold name and an *Unarchive* button
  that appears on row hover or keyboard focus; its cards and chats stay,
  its key stays taken, and a link from a notification still opens its card. Its queue stands still
  whatever its settings (`queueHeld`; Ready cards say *the board is archived*), and the board cannot
  be archived while a run on it is queued or running (`tests/store-archived-board.test.mjs`).
- **What a mention wakes** — `@handle` in a chat message starts a run for that agent, but only
  where it is addressed to somebody: a handle inside backticks, a ``` block or a quoted line
  (`>`) wakes nobody, and an agent naming an agent on a card already in Review or Done starts
  nothing either (a human's mention there still does). `triggerMentions` / `addressedText` in
  `src/server/store.ts`.
- **An answer wakes the agent that asked** — an agent's run started by another agent's mention
  is that agent's question; its reply queues a run for the asker (`reply:<answerId>`, "Architect
  answered — Coder continues." in the thread) even without a tag. Once per question, at most 3
  such rounds per card an hour — the next stops the card with `needs_owner` reason `agents_loop`.
  An answer that tags a human (the owner, an outside Claude) wakes nobody and stops the card for a
  human instead. `wakeAsker` in `src/server/store.ts`, `tests/store-reply-wake.test.mjs`.
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
  handed off in another lands in one commit — the snapshot survives a trip through Ready or
  Review and is dropped only by a commit or a move to Done / Backlog. Tracked files still
  modified after a commit are listed in the chat as a warning (the owner's edits, or work the
  commit missed); a commit git refuses keeps the card in In progress
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
  `running` with no report for longer than the run timeout (the agent's own, if longer) + 5 min
  becomes `failed` with "The
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
- **Loops are stopped, not turns** — the turn limit is 200 for every role unless an agent sets its
  own (a safety net; the Architect's dispatch no longer dies at 20). The worker watches each run
  while it streams (`claude --output-format stream-json --verbose`, `codex exec --json`) and stops
  it on the same call three times in a row, the same failing command with the same error three
  times, or 25 calls in a row that only repeat earlier ones with no file changed
  (`agents/loops.mjs`). The chat gets a system line — what repeated, the last call, "Stopped as a
  loop" — and the run closes as failed with `loop`; a coder's work in the tree gets the same one
  continuation as the turn limit. The run log now shows one `→ <call>` line per step instead of the
  CLI's raw output. Board-level: a card whose hand-off comes back (check failed, review asked for
  changes, Review → In progress) more than 3 times, or where agents write 6 messages in a row with
  no hand-off, stops with `needs_owner` reason `agents_loop` and notifies the owner
  (`bounceCard`, `MAX_AGENT_CHAIN` in `src/server/store.ts`). Needs a worker restart to go live.
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
- **Parallel work, step 1: a worktree per card** (BI-115) — a board setting, off by default. On,
  a coder's first run on a card in In progress makes the card a git worktree on `cs/<KEY>-<N>`,
  cut from the branch the board's checkout is on, in `<repo>.worktrees/<KEY>-<N>`, and runs the
  board's *Setup command* there once (`agents/git.mjs`, `openWorktree` in `agents/worker.mjs`).
  Every run on the card — the coder, the check, the commit, the Architect's review — works in that
  folder. When the card is released (Done, or Review with *Next card starts after: Architect
  approves*) the board merges the branch into its base (fast-forward or a merge commit) and removes
  the worktree and the branch (`src/server/worktree.ts`, `landIfReleased` in the store). A merge
  that does not apply is aborted, everything is left as is and the card's chat says so. The card
  panel shows the branch (`tests/store-worktree.test.mjs`).
- **Parallel work, step 2: several coders at once** (BI-116) — with Parallel work on, the board's
  *Max coders at once* (1–6, default 2) is how many coder runs work in the repository side by
  side, each in its own card's worktree (`repoBusyForCoder` in the store); a run in the board's
  own checkout still works alone. With *One card at a time* on, the queue holds once that many
  cards are in work, and each frees its slot where a single card would (`queueHeld`). A coder
  still does one card at a time; a blocked card still waits for its blocker's branch to land.
  The board header shows *Coders N/M*, the Agents page how many coders run right now
  (`tests/store-parallel.test.mjs`).
- **Parallel work, step 3: the Architect plans what runs together** (BI-117) — with Parallel work
  on and more than one coder slot, the dispatch prompt adds `agents/prompts/dispatch-parallel.md`:
  the coder limit, that each card runs in its own copy, and that cards building on each other or
  touching the same files wait (`blocked_by`, In progress cards included) while clearly separate ones run in parallel — sequential when unsure. The
  dispatch note says in one line what runs together and what waits.
- **Parallel work, step 4: merge conflicts go back to the coder** (BI-118) — a card whose branch
  conflicts with what landed on main meanwhile is not left waiting: the board aborts the merge,
  moves the card back to In progress and its coder (tagged, else the last one that ran on it) gets
  a `conflict:` run with the conflicting files in the chat (`sendBackForConflict` in the store).
  The worker starts `git merge --no-commit <base>` in the card's worktree before the agent runs
  (`startMerge` in `agents/git.mjs`); the coder resolves the markers and hands off as usual, and the
  commit step concludes the merge — refused while a conflict marker is left. The next release lands
  it. A second conflict after that round stops the card for the owner; a human answering gives the
  coder its round back. A card it blocked that the release had already pulled into In progress, and
  that has no worktree or started run yet, goes back to the top of Ready with its coders'
  queued runs cancelled — an Architect's answer queued there stays (`requeueDependents`). Other cards' worktrees are never updated under a running run — each catches
  up with main only at its own merge (`tests/store-worktree.test.mjs`).
- **Parallel work, step 5: cleanup, disk and polish** (BI-119) — a card archived, deleted or moved
  back to Backlog takes its worktree and branch with it (`--force`, `branch -D`). Uncommitted work
  in the worktree is first committed onto the branch as the board (`add -A`, `--no-verify`,
  unsigned; nothing is removed if that commit fails). The chat names the commit the branch ended
  on; for a deleted card the server log does. A run still working in the worktree keeps it until
  the run ends (`dropIfAbandoned` in the store, `dropWorktree` in `src/server/worktree.ts`). A
  released card whose branch never landed keeps it when archived. Every worker start calls
  `POST /api/worktrees/sweep` (`sweepWorktrees`), and the worker logs each branch removed with its
  last commit. The sweep removes only branches named like the board's own, `cs/<board key>-<n>` or
  `cs/<card id>`, and only when no live card needs them; the owner's own branches are never
  touched, and neither is a folder outside `<repo>.worktrees/` (the main checkout or the owner's
  own worktree on a board-named branch): nothing is committed there, removed or deleted. With no setup command, a fresh worktree gets the repository's node_modules cloned
  copy-on-write, but only when `node_modules` is git-ignored and a clone probe passes. On Linux
  the probe is one `FICLONE_FORCE` copy; on macOS, where Node lacks that copy, it checks for the
  same APFS volume. The run log says how much disk the worktree takes (`cloneNodeModules`,
  `diskUsage` in `agents/git.mjs`). The card shows its branch and *In parallel* while its coder
  runs; README has a *Parallel work* section.
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

- **Mac app (spike, BI-113)** — `npm run dist:mac` builds an unsigned arm64 DMG (~192 MB, app
  ~455 MB; the bundled git is 150 MB of it) in `release/`: Electron launcher in `electron/`, the
  board and worker as hidden children on a free 127.0.0.1 port, data in
  `~/Library/Application Support/creative-space`, git from dugite first on the PATH, `claude` /
  `codex` found in the usual install folders. `npm run app` runs it unpackaged after
  `npm run build:app`. `npm run up` is unchanged and still uses `data/`. File → Board Details… (⌘,) reaches the page
  as the `cs:board-details` window event.
- **Mac first launch (BI-127)** — Electron sets `CS_APP=1` for both children. Fresh app data
  contains the owner and two agent profiles but no sample boards or cards; dev keeps its seed.
  A new folder defaults to no “describe the project” run; choosing an existing folder enables
  that option. In app mode the store requires an existing absolute folder for boards with
  agents. Missing or bundled paths (including symlinks) block enqueue/claim with a card note;
  the worker and adapters also refuse them before running tools, checks or commits. The role
  prompts no longer refer to repository-only templates. Archiving a board without a folder
  works; the folder check runs only when `repoPath` or `memberIds` change. Every runtime
  filesystem call on a dynamic path in `store.ts`, `uploads.ts` and `db.ts` carries
  `turbopackIgnore`; `npm run build:app` prints no "Dynamic filesystem access" warnings and the
  route traces (`.next/server/**/*.nft.json`) hold only `node_modules` and server chunks — no
  `.git`, `.env`, `data/`, `src/`, `uploads/`, `release/` or `templates/` (checked on the
  build's own traces, before the packaging cleanup). A folder named like `acme.app` is a bundle
  only if it has `Contents/Info.plist`. The packaging allowlist stays as a safety
  net. Note: `src/server/store.ts` now imports `agents/project-dir.mjs`, so `agents/` is no
  longer entirely outside the Next build. Typecheck, lint and all 400 tests pass. Not yet run:
  starting `.next/standalone/server.js` with `CS_APP=1` and a throwaway `CS_DB_PATH` to see an
  empty `/api/state`.
- **Mac app: update check.** On launch and every 6 hours the app reads the latest GitHub
  Release (`electron/updates.mjs`, no token). A newer version gives one Download / Later dialog per
  version and a "… is available — Download" item in the app menu that opens the release's
  `.dmg`. App menu and Help → "Check for Updates…" ask on demand ("You're up to date" /
  "Couldn't check"). No silent in-place update yet — that needs a signed app. The menu is now
  rebuilt with the standard roles. `npm run version:bump -- patch|minor|major|x.y.z` edits the
  version only (no commit, no tag).

## Broken / known issues

- **The Mac app is a spike.** Unsigned (Gatekeeper wants right-click → Open), default Electron
  icon, no auto-update, no onboarding. Telegram settings are still inherited from the launch
  environment / repository `.env` — the app has no place to set them (BI-128).
  Notification links point at the launch's random port.

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
- **Every Ready move costs a model call.** On a board with an Architect, dispatch is a run of
  its own before the coder's — *Architect: off* is the way out when something else plans the
  board.
- **A second human has no UI.** Adding one (an outside architect in the owner's chat) is a
  `POST /api/members` by hand; the board's details only let you take them off a board, not
  put them on it.
- **A card created by an agent cannot create more cards** — deliberate, but it means a
  decomposition is one level deep.
- **A worktree whose merge git refused for a reason other than a conflict just waits** (the
  board's checkout on another branch, the owner's uncommitted edits in the way); the card's chat
  says what git refused. A card that conflicted goes back to In progress, but a card the move that
  released it pulled only because a slot came free has started already, on a main without its work
  (a card it blocked goes back to the top of Ready while nothing has started on it).
- **A card deleted while a run works in its worktree** leaves the worktree and branch until the
  next worker start sweeps them; so does a cleanup git refused. A filesystem that cannot clone
  (not APFS / btrfs / XFS) gives a worktree with no setup command no node_modules at all.
- **An archived approved card whose landing failed keeps its branch and worktree** until someone
  lands or deletes it by hand — the sweep leaves it too.

## Next

- Nothing planned right now.

## Not doing (for now)

- Accounts, auth, hosting: everything runs locally against one SQLite file by design.
- Calling model APIs with keys — agents run on the Claude Code / Codex CLI and the user's own
  subscription.
- Pushing to a remote or rewriting history from the board.
