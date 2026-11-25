# Decisions

The decision log. Newest first. One entry per real choice — something a future reader
would otherwise re-litigate. Keep entries short; link to the feature file for detail.

Append an entry when you pick an approach, a library, a data shape or a trade-off that
was not obvious. Do not edit old entries: if a decision is reversed, add a new one that
says so and why.

The first four entries were written on 2026-10-07, after the fact: the decisions were
already in the code and in the commit history, but nowhere a reader could find them.

---

## 2026-11-04 — The Mac app is an Electron launcher around the unchanged board and worker

**Decision:** (BI-113, spike) `npm run dist:mac` builds an unsigned arm64 DMG. `electron/main.mjs`
only launches: the Next.js standalone server and `agents/worker.mjs` run as hidden children of
Electron's own binary with `ELECTRON_RUN_AS_NODE=1` on a free 127.0.0.1 port, one window on it,
both stopped on quit — each in its own process group, so quit SIGTERMs the worker's group (and
the `claude` / `codex` of a run in flight) then the board's, and SIGKILLs both after 5 s: the
worker alone would wait for that run and outlive the app. Data goes to `~/Library/Application Support/Creative Space` through the
existing `CS_DB_PATH` / `CS_UPLOADS_DIR` — no change to `src/` or `agents/`. Git is dugite's,
put **first on the PATH** with `GIT_EXEC_PATH` rather than threaded through the code as a path:
every `git` the store, the worker and the agents themselves run is then the bundled one, and
a Mac without the developer tools never hits the `/usr/bin/git` stub that opens an install
dialog. `claude` / `codex` are found by adding the usual install folders to that PATH
(`~/.local/bin`, Homebrew, `~/.npm-global/bin`, nvm, Volta, Bun). The server and git are copied
into `Contents/Resources` by an `afterPack` hook, and `scripts/build-app.mjs` prunes the
standalone build to an allowlist.

**Why:** Electron 45 runs Node 24.22, where `node:sqlite` works as is — no second Node to ship.
Running the children from Resources (not the asar) is what lets them exec binaries. The prune is
not optional: because the store joins paths onto `process.cwd()`, Next's tracer copies the repo
root into the standalone build — `.env` (the Telegram token), `.git`, and `data/` with a board
running — and `outputFileTracingExcludes` does not reach those. electron-builder's
`extraResources` silently drops `node_modules` and `.next` and dereferences git's 148 symlinks,
hence the hook. The unpackaged app (`npm run app`) uses the app data folder too, not `data/`: a
second worker on the database `npm run up` is serving would claim its runs.

**Rejected:** a `CS_GIT` path passed into the store and worker — touches every spawn and still
leaves the agents on the system git; asking the login shell for its PATH (`$SHELL -ilc`) — slow
and can hang on an interactive rc file; shipping a separate Node binary — unneeded once
`node:sqlite` worked under Electron.

## 2026-11-03 — A failed check retry escalates one step, to the closest higher tier present

**Decision:** When a Fast or Standard coder's check fails after its one retry, the board queues an
Architect run (`escalate:<messageId>`) instead of stopping for the owner. The Architect either
hands the card on with `{"escalate": "<handle>"}` or asks the owner. The store accepts it only from
the board's Architect, only while the card's escalate run is the last thing that happened on it
(no coder ran since), once per card (`tasks.escalated_at`), and only to a coder of the closest
higher tier that has a coder on the board — Fast → Standard, or → Strong when there is no Standard
coder (`nextTierUp` in `src/lib/tiers.ts`). The new coder gets its own check and retry; if those
fail, the owner looks, as before. The retry itself is now counted from the run that reports the
check (it is still running then), not the last finished one — that rule let a coder fail twice
after the first failure.

**Why:** BI-114: a cheap coder that cannot finish should cost one step up, not a Strong model on
every card. One step keeps the bill proportional and still reaches Strong from Fast when Standard
is absent. The Architect decides, not the board alone, because a check that fails on the
environment or an unclear card would fail the same way on a dearer model.

**Rejected:** Jumping straight to Strong (pays the most when the next tier would have done);
escalating without the Architect (no one tells an environment failure from a weak model); more
than one step per card (a card that fails at two tiers needs a human, not a third model); storing
the escalation as an event only (the rule needs a cheap, durable per-card fact — a column with a
migration is that).

## 2026-11-03 — The Architect sizes a card at dispatch; the size picks the tier

**Decision:** Every Ready card gets a size, S / M / L, in the dispatch decision (`"size"` next to
`assign`), and goes to the cheapest coder tier that can do it: S → Fast, M → Standard, L → Strong,
the next tier up when the board has none of that tier. The size is stored on the card
(`tasks.size`) and shown as a badge. A busy cheap coder is not a reason to pick a dearer one, and
a card the owner tagged keeps its coder. A bad size is dropped alone — the rest of the decision
still applies. See `docs/features/cost-aware-routing.md`, item 2.

**Why:** The Architect already reads every Ready card at dispatch, so sizing costs no extra call.
Storing the size makes the routing visible and checkable on the board, and gives item 3's
escalation the starting tier. Coders on one repository run one at a time, so waiting for the
cheap coder costs no speed — only a dearer coder costs more.

**Rejected:** Mapping size → coder in code (the Architect still has to judge the description
within a tier, and a board's coders change); a size set by hand on the card (the owner would
have to size every card); failing the whole decision on one bad size (the order and the tags
would be lost for a typo).

---

## 2026-11-03 — A coder tier is a model plus an effort

**Decision:** Coders carry a tier — Fast, Standard, Strong (`members.tier`) — and a tier stands
for a model *and* an effort: Fast = haiku / gpt-6-luna at low, Standard = sonnet / gpt-6.1-sol at
medium, Strong = opus / gpt-6-astra at high (`src/lib/tiers.ts`). Picking a tier fills both in
the agent editor; both stay editable, and the worker runs what is on the agent. Existing coders
get their tier from their effort (low → fast, medium → standard, high/max → strong, none →
standard); architects have none. A model the CLI rejects fails the run naming the engine and
the model. See `docs/features/cost-aware-routing.md`.

**Why:** Cost is the product of both: the same model at high effort costs several times what it
does at low, so a tier named after the model alone would let a "Fast" coder burn a Strong
budget. Effort is also the only signal existing coders have, which makes the migration a
mapping rather than a guess. Failing loudly on a bad model, instead of falling back to the
CLI's default, keeps a card from silently running on a tier nobody picked.

**Rejected:** Tier = model only (effort left to chance); tier as a computed label read off the
model name (breaks on full model ids and new releases); a tier on architects (the Architect
routes, it is not routed); retrying a rejected model on the default (a different, unchosen cost).

---

## 2026-10-13 — Everything a user sees is English; the owner's line is `In short:`

**Decision:** The bot's replies, the notification labels (`Answer`, `Question`, `<ref> moved to
Done`), the turn-limit message and the UI are English, and so are the comments, tests and docs.
The role prompts ask for `In short: …`; the parser still accepts `Briefly:` and the Russian
marker, spelled as `\u{…}` escapes in the regex so the source stays Latin. The bot's hint shows
`BI-69 to Done`; any other wording still reaches the card's chat, where the architect reads it.
Cyrillic is left only in the board-key transliteration table and in tests that check non-Latin
input on purpose, each marked with a comment.

**Why:** The repository is public, and a Russian string in a bot reply or a test is noise to
everyone else. Agents translate the marker along with the line when they answer in the owner's
language, so dropping the Russian one would silently lose the notification text on such boards.

**Rejected:** Localising the UI and the bot (a feature, not a cleanup); keeping the Russian word as the
prompted marker (the prompts are English, so the marker should be too).

## 2026-10-13 — The board listens on 127.0.0.1 only

**Decision:** `npm run up`, `npm run dev` and `npm run start` pass `--hostname 127.0.0.1` to
Next.js; `HOST` overrides it for someone who wants the board on the network. `dev` and `start`
go through `scripts/next.mjs`, `up` sets the flag itself. Links and `CS_API` stay
`http://localhost:43123`.

**Why:** Next binds to every interface by default, so anyone on the same Wi-Fi could open the
board and queue cards — and agents run cards with the right to change files and run commands
on the owner's machine. The board has no login; the network boundary is the only one.

**Rejected:** `${HOST:-127.0.0.1}` straight in package.json (no shell defaults in Windows' cmd);
binding `localhost` (Next would pick one of IPv4/IPv6, 127.0.0.1 is explicit); adding auth to
the board (a feature, not a release fix).

## 2026-10-13 — A hand-off with nothing to commit goes on to the review

**Decision:** Reverses part of *The commit's "before" belongs to the card* (2026-10-07). When a
coder hands a card off, the check passes and the card's work changed no file, the card goes on
to the Architect's review like any other hand-off; the chat gets the system line *No file
changes in this run — nothing to commit.* and the feed keeps its `commit_skipped` line, but the
owner is not notified about it (they hear about the card when it reaches Review). A commit git
refuses and a failed check still hold the card in In progress.

**Why:** Max Shakurov's call for 0.1.0: the stub coder changes no files, so in the stub
mode the README suggests for a first try every card stuck in In progress for good. Answer-only
cards in live mode hit the same wall. The bug that once made "nothing to commit" dangerous —
the run's own snapshot hiding an earlier run's work — is fixed by the card's snapshot, so an
empty diff now really means no change; the Architect's review is where a hand-off with no
work behind it gets caught.

**Rejected:** Doing it in stub mode only (the stuck card is just as wrong in live mode); keeping
the "No commit" notification for this case (it would buzz on every stub card for no reason).

## 2026-10-08 — The bot's confirmation is the agent's answer, and 👍 means only "into Done"

**Decision:** Three rules, replacing the two confirmation entries below. (1) The bot says nothing
when a message is delivered: no 👍 on the owner's own message, no `✓ to chat BI-69` line. It writes only
failures, plus one case where nothing is going to answer — the board woke nobody (no architect,
no tag), which `addMessage` now reports as `woke: []` on the posted message (`PostedMessage` in
`src/server/store.ts`). (2) The answer to a message that came in from Telegram goes back to
Telegram: the bot stores the owner's own Telegram message id with the message
(`messages.telegram_message_id`), and when the agent that run woke answers on the card, the board
records an `agent_answered` feed line and the notifier sends `BI-79 · <the agent's words>` as a
reply to that message. Exactly one answer per message of theirs
(`messages.telegram_answered_at`); everything the agents go on to say stays on the board. A board
with detailed notifications off gets `UG-3 · Agent replied in the card chat` and no corpus data.
(3) One reaction: `REACTIONS = ["👍"]`, and the owner's 👍 on a card in **Review** moves it to
Done — on the board and from Telegram alike. A 👍 anywhere else is a mark, and the bot says so
out loud, because silence there would read as "done". 👎 ✅ 👀 ❓ and "👍 = yes" are gone from the
types, the store, the bot and both role prompts.

**Why:** A confirmation the owner has to read and then ignore is noise; the thing that proves the
message arrived at the right card is the agent answering it, and a wrong guess at the card is
visible in that answer not matching what was asked. The answer coming back to the phone is what
makes the bot a conversation rather than a one-way remote. And five meanings on five emoji turned
out to be four meanings nobody used: the owner answers a question in words, so the gesture is
left with the one thing a gesture does well — signing work off.

**Rejected:** Keeping the `✓ to chat …` line for a guessed card (the answer already shows where it
went); sending every agent message on the card back to Telegram (the card's chat is not a group
chat on the phone); keeping ✅ for Done next to 👍 (two gestures for one meaning, and ✅ is the
harder one to reach); letting the board say nothing when a 👍 moved nothing (the owner would read
the silence as a card closed); the answer taking up the card's two-minute notification window
(somebody who just wrote is waiting, and gluing an answer into a `card_moved` line would drop
both its text and what it replies to).

---

## 2026-10-08 — A reaction is a message: five of them, and only the owner's mean anything

**Decision:** Reactions are a fixed set of five — 👍 "yes", 👎 "no", ✅ "done", 👀 "looking",
❓ "didn't get it" (`REACTIONS` in `src/lib/types.ts`) — stored one row per (message, member, emoji)
in `message_reactions`. Anybody may put one on; only the **owner's** does anything, and only two
things: 👍 👎 ❓ on a message whose addressed part tagged the owner answers that question (the
author is woken once by an ordinary message from the owner, `source = "reaction"`, with the
question's own `In short:` line quoted back), and ✅ on a card in **Review** moves it to Done with
no run. Everything else is a mark. The authority of a reaction is the authority of a message from
Telegram: enough to move a card and to answer an agent, never enough for a paid call, a corpus
write or a deploy — written into both role prompts, because it is the agents that keep that rule.
A reaction never notifies anybody; what the board *does* about one arrives as the line of that
(a card moved to Done). In Telegram, each notification now remembers the board message it is
about (`telegram_notifications.board_message_id`), so a reaction on the notification is the same
reaction on that message.

**Why:** The answer the owner has to give is usually one bit — yes, no, or "say that again
simpler" — and typing it on a phone is the whole friction. Whether a message was a question is
already decided elsewhere (the tag on the owner's handle), so a reaction needs no new
intent of its own: it answers the message it is on. Going through `addMessage` rather than
inventing a second wake-up path means the mention rules, the `needs_owner` release and the
"one run per agent per card" guard all apply unchanged — the agent cannot tell a reaction from a
typed answer, which is the point.

**Rejected:** A free-form emoji (the board would have to guess what one means, and the meaning is
the whole feature); reacting to an *agent's* reaction (nobody asked, and it doubles the rules);
storing the meaning in the database (it is behaviour, it belongs in `store.ts`); reading
`owner_mentioned` out of the feed to decide whether a message was a question (the feed is pruned
after 30 days — the message itself still says so); letting ✅ close a card outside Review (that
would be the owner skipping the work, not signing it off); a reaction from the owner unlocking a
paid call or a deploy (it is one tap and easy to misfire — the same line Telegram already draws).

---

## 2026-10-08 — The `@` on the owner's handle is what buzzes their phone

**Decision:** A chat message whose addressed part names the owner's handle, written by anybody
but the owner, records an `owner_mentioned` line in the feed (`triggerMentions` in
`src/server/store.ts`), and the notifier labels it `Question` (`classify` in `agents/notify.mjs`)
with the author's `In short:` line under it — or, when there is none, the first 200 characters of
the message with the code taken out (`askedLine` in `src/lib/plain-text.ts`). It is the same
`addressedText` the runs use, so a handle in backticks, in a ``` block or in a quoted line says
nothing. Both role prompts now reserve the tag for that one use: tag `@<owner>` only when you
need an answer or a decision, write the owner's name without the `@` everywhere else — and the
prompts themselves were rewritten the same way, since a prompt that tags the owner fifteen times
in its own prose teaches exactly the habit it forbids. The two-minute glue and both board
switches apply unchanged: a tag and a move to Review inside one window are one notification.

**Why:** This completes the four kinds of notification the owner approved — needs a decision,
Review, Done, failures — and nothing else. `needs_owner` only covers the case where the agent
stops the card; an agent that asks a question and keeps working had no way to reach the phone,
and the owner had to notice it on the board. Making the `@` the signal needs no new action and no
guessing at intent: the agent decides by writing one character, which is a rule a prompt can
state in a line.

**Rejected:** Reading the owner's intent out of the message text (a guess per message, in two
languages); notifying on every agent message on a card the owner is on (that is the Telegram
chatter the owner ruled out); a new `ACTIONS` field for "this is a question" (`needs_owner`
already is one, for the stronger case — a second one would mean choosing between them);
restricting the line to agents (a second human on the board tagging the owner is the same
question, and `owner_mentioned` carries the author's handle for whoever cares).

## 2026-10-08 — A card reaching Done notifies the owner; agents do not answer in Telegram

**Decision:** `card_moved` with `to = "done"` is the seventh thing worth a notification, labelled
`Done` next to the existing `Review` (`classify` in `agents/notify.mjs`). It is one rule for every
mover — a person dragging the card, the bot, the Architect after a review, an outside client over
the API — because the board records the move identically for all of them (`recordMove` in
`src/server/store.ts`); the two-minute glue and the board's two notification switches apply
unchanged. The other half of the decision is a *no*: an agent's reply does not go back out to
Telegram.

**Why:** What the owner wants from the phone is to know a card is finished, not to read the run.
Done is the one state change nobody else announces — Review is a hand-off the owner may already
be watching, Done is the end. Routing agent replies into Telegram would mean every run's prose
leaving the machine, which is exactly what *Detailed notifications* exists to prevent, and the
loop (bot message → card chat → agent reply → bot message) has no natural end.

**Rejected:** Mirroring agent replies into the Telegram thread the owner wrote in (the original
shape of this card — dropped by the owner); a separate "card finished" event type (`card_moved`
already says it, with the mover and both columns); notifying on `commit_made` instead (a commit
is the board working, not the card being done).

## 2026-10-08 — What a notification says in words is written by the agent, not assembled by the board

**Decision:** A notification may quote exactly one thing an agent wrote: the `In short: …` line
the role prompts ask for at the end of every reply that hands a card off, asks the owner for a
decision or reports a failure — one or two sentences in the owner's language, no code, no paths,
no logs, no file names. The parser lifts it out of the reply (`plainLine` in `agents/lib.mjs`),
the worker carries it with the move, the `needs_owner` and the failed run, and the board stores
it on the event as `plain` — 300 characters, inside the event's `data` rather than a column of
its own, so an older board's rows simply have none. The notification is then
`BI-69 — Review: <title>`, the line, the link. Per board, *Detailed notifications*
(`boards.notifications_detailed`, on by default) drops the line for a board whose text should not
reach Telegram.

**Why:** `BI-69 · Review · <title>` told the owner that something happened, never what. The
board cannot write the missing sentence itself: everything it has is a summary it composed about
itself (`run_failed` quotes a CLI's words, a path, a log tail), and the chat message in full is
the one thing a notification must never carry. The agent is the only party that knows what it
did and can say it in one sentence — so it is asked for that sentence, and nothing else of the
reply is ever read for it.

**Rejected:** summarising the reply or the run log on the board (guesses, and leaks the very
things the notification is supposed to keep out); a second model call to write the summary (money
and latency for a line the agent could have written in its own run); a separate `plain` column on
`events` (a field only the notifications read does not need one, and it would mean a migration
for every board).

## 2026-10-08 — A message to the bot always lands somewhere, and the bot always says where

**Decision:** The bot addresses a card in three steps, in this order (`readUpdate` in
`agents/telegram.mjs`): the notification the message is a reply to, a card number in the text
(`BI-69`, two to six letters and a number, case-insensitive), otherwise the card of the last
notification it sent — if that notification is less than 24 hours old. Every message it delivers
is confirmed with the card it went to: `✓ to chat BI-69 "Title"`. The three lookups are the
board's (`taskOfTelegramNotification`, `taskByRef`, `lastTelegramNotification` in
`src/server/store.ts`, behind `GET /api/telegram/notifications`); which one applies, and how
fresh "last" has to be, is the bot's rule.

**Why:** On a phone the owner writes "move it to Done", not a reply to the right notification.
Guessing the card is the only way to make that work, so the guess is made cheap to correct
rather than avoided: the confirmation names the card, and a wrong one is re-sent with the number.
The 24-hour cut-off is the line past which the board has moved on and a loose message is about
something else entirely.

**Rejected:** Requiring a reply or a number always (the whole point was not having to); taking
the last notification however old it is (a message the next morning would land on yesterday's
card); a `/to BI-69` command (a number in ordinary text is what the owner already writes); the
bot resolving numbers out of `/api/state` (the board's own SQL is one query and knows about
archived boards); treating an unknown `/command` as a message for a card (sending `/start` into
a card's chat only confuses the architect).

## 2026-10-08 — The Telegram bot answers by reply, and the board remembers which card each notification was

**Decision:** The bot is two-way. The worker reads it with `getUpdates` long polling in its own
loop (`agents/telegram.mjs`), not on the worker's tick and not through a webhook. Every
notification the board sends about a card stores its Telegram `message_id → task_id` in
`telegram_notifications` (`src/server/db.ts`), read and written over HTTP at
`/api/telegram/notifications` — so a **reply** to a notification is the routing, and the text
becomes a message from the owner on that card with `source = "telegram"` (`messages.source`, a
small label in the UI). Not a reply: `/status` prints In progress / Review / "Waiting for the owner" per
board, anything else gets a one-line hint. Only `TELEGRAM_CHAT_ID` is listened to; a foreign chat
gets no answer and one log line without its text. Covered by `agents/telegram.test.mjs` and
`tests/store-telegram.test.mjs`.

**Why:** Away from this machine a notification is all the owner gets, and the link in it points at
localhost. Long polling needs no port open and no tunnel, which is the whole reason the board is
local-only. The `message_id` is the one handle Telegram gives a reply for free — no command
syntax for the owner to remember and no card number to type, which is what makes answering from a
phone actually faster than opening the board. It lives in the file and not in the worker's memory
because the owner answers hours later, long after the last restart.

**Rejected:** A webhook (a public URL for a board that is deliberately local); keeping the
`message_id` map in the worker's memory (a restart loses every notification already sent); a
`/say BI-72 …` command (the owner has to know the number, and it is the thing a notification
already said); letting the worker open `data/board.db` itself (it talks HTTP by design);
re-implementing "untagged → architect" in the bot (it is the board's rule, and a message that
came in from Telegram is just a message the owner wrote); replaying the backlog of updates on
start (a reply from yesterday is history — the same line `agents/notify.mjs` draws at its start).

## 2026-10-08 — An untagged message of the owner belongs to the board's architect

**Decision:** In `triggerMentions`, a chat message whose author is the owner and whose addressed
part holds no handle at all queues one run for the board's architect, trigger `owner:<messageId>`,
with the busy rules of a human's mention (`follow`). A tag still wakes only the agents it names.
On a board with the architect switched off nothing runs and the feed gets an `owner_message` line
(ref, author, message id — not the text) for the architect outside the board. The parser
(`agents/lib.mjs`) accepts `"move": "done"` from an architect only in an `owner:…` run; anywhere
else it is refused with a `problem`. Covered by `tests/store-owner-message.test.mjs` and
`agents/lib.test.mjs`.

**Why:** The owner writes in a card's chat and forgets the tag — and the message sits there with
nobody woken by it, which from the outside looks like the board ignoring its owner. The architect
is the one participant that can act on anything said about a card, so it is the default
addressee. The trigger carries that it was the owner asking, which is what makes closing a card
safe: Done stays the owner's decision, the architect only executes it, and the permission lives
in the run rather than in the agent's judgement about its own reply.

**Rejected:** Waking everybody on the card (two or three runs for one sentence, and the coders
spend quota on remarks); reading the owner's intent out of the text (a guess per message, in two
languages); letting the architect move a card to Done whenever it thinks the owner agreed (the
prompt already said "never Done" because that judgement is not reliable); storing the message
text in the `owner_message` event (the feed is one short line and the text is in the chat, which
the external architect reads anyway).

## 2026-10-08 — The schema version does not decide whether migrations run

**Decision:** `catchUp()` runs `SCHEMA` and `migrate()` on every open of the board file,
whatever `PRAGMA user_version` says (`src/server/db.ts`). The stamp is written after the
catch-up, only ever upwards, and is read for one thing: the log line that says the file was
behind this build. Covered by `tests/db-migrate.test.mjs`.

**Why:** Every step is already idempotent — `CREATE … IF NOT EXISTS`, a `PRAGMA table_info`
check before every `ALTER` — so re-running them costs a handful of PRAGMAs. And the stamp
cannot be trusted: a dev server compiles whatever `db.ts` is on disk, so a file gets stamped
with a version whose columns were not written yet, and from then on every open believes it is
up to date. That broke a live board twice in one day (`user_version` 16 with
no `boards.notifications_enabled`, `GET /api/boards` → 503, and a restart did not help, because
nothing about restarting lowers the stamp). The file's own column list is the only thing that
describes a file written by code that no longer exists.

**Rejected:** Bumping `SCHEMA_VERSION` whenever this happens (a manual step, done after the
board is already broken, and it cannot fix a file stamped *ahead* of the code); a
down-migration or re-stamping backwards (it would re-run migrations against databases from a
newer build); dropping `user_version` altogether (it still names what a file has seen, and the
"migrated without a restart" line is worth keeping).

## 2026-10-08 — A mention wakes an agent only where it is addressed to somebody

**Decision:** `triggerMentions` reads handles from the message with the code spans, ``` blocks
and quoted lines (`>`) stripped out (`addressedText`), and an *agent's* mention of an agent on a
card in Review or Done queues nothing — a human's still does (`src/server/store.ts`).

**Why:** Agents quote handles while talking about a card: a review that cites `@coder` as the
trigger of the bug it describes put a second coder run on a card that was reviewed and already
committed. The two filters are about different mistakes — the markup one is about what the text
means, the Review/Done one is a backstop for the case where it slips through anyway.

**Rejected:** A full markdown parse (the board stores plain text and shows it almost as-is —
line-level fences plus paired backticks is the same answer for three lines of code); dropping
*all* mentions on a finished card (the owner reopens a card by naming its coder, and that has
to keep working); asking the agents in their prompts not to quote handles (a prompt is not a
rule, and this one was already being broken by a correct review).

## 2026-10-08 — "Waiting for the owner" holds the card, not the coder

**Decision:** A card with `needs_owner` sitting in In progress no longer makes its coder busy:
`coderBusyReason` skips it, the same way it skips a card whose review is with the Architect
(`src/server/store.ts`). The coder takes the next Ready card; the owner's answer re-queues a run
on the parked card, which simply waits its turn in the coder's run queue.

**Why:** The wait is on a human and can be hours, while the coder and the checkout are idle.
The flag's job is to stop *that card* from moving, and everything that does that
(`enqueueRun`, `triggerMentions`, the queue) is keyed on the card, not on the agent. A coder
can already hold more than one card in In progress — that is what `awaitingReview` established.

**Rejected:** Moving the parked card back to Ready or to a column of its own (it loses the
work in the checkout and the thread's place in the flow); keeping the coder pinned and relying
on the owner answering quickly (that is exactly the case this breaks).

## 2026-10-08 — Notifications live in the worker, read the feed, and carry three fields

**Decision:** `agents/notify.mjs`, inside the worker: it polls `GET /api/events` per board every
5 s from its own cursor and sends what the rules pick out to macOS (`osascript`) and Telegram.
A notification is composed from three fields and nothing else — the card's number, a label for
what happened and the card's title (the feed now carries the title, cut to 60 characters) plus a
`/?task=<id>` link the board opens the card from. Per card, one notification per 2 minutes;
what happens inside that window is held and glued into one, `+N`. Per board, a *Notify me*
switch (`boards.notifications_enabled`, on). Nothing from before the worker started is ever
announced, and a board with the switch off still has its feed drained — otherwise turning the
switch back on would buzz about the whole session.

**Why:** The worker is the only process that is always up, already speaks to the board over
HTTP and can spawn a CLI; the Next server would have to notify from inside a request. Reading
the stored feed instead of hooking into the store keeps the rules in one file, out of the
product's hot path, and makes them testable against plain objects. Three fields rather than the
event's own `summary` is the privacy rule made structural: a summary can quote a CLI's first
line, so the module never reads it — no chat text, no log, no diff, no paths can leak into a
phone. The token comes from the git-ignored `.env`, is never logged, and is scrubbed out of the
error messages that would otherwise quote the API URL.

**Rejected:** Notifying from `src/server/store.ts` next to `recordEvent` (the board would be
spawning processes and calling out to the network inside a write transaction, and a Telegram
timeout would become a failed card move); `node-notifier` / a Telegram SDK (two dependencies for
one `execFile` and one `fetch`); a per-event mute instead of a per-card window (the point is one
buzz per card, whatever happened to it); putting the whole state read behind `/api/state` for
the board list (every card of every board, every 5 s, for two flags — hence `GET /api/boards`).

## 2026-10-08 — Closing a run is the first thing a failure does, and the board has a watchdog

**Decision:** Three rules, so a run cannot stay `running` after its worker is done with it:

1. The worker closes the run on the board *before* it writes anything in the card's chat
   (`reportFailure` and `closeRun` in `agents/worker.mjs`), and every reporting step of a
   finishing run — the reply, the check note, the commit note, the card's move — is tolerated
   on its own: a refusal is noted in the run's summary and the run still closes. The commit sha
   goes into the summary as well as the chat, so it survives a chat that refuses the message.
2. The board judges a run by itself: `running` with no report for longer than the worker's run
   timeout plus five minutes → `failed` with "The worker lost the run" and a system message
   (`sweepLostRuns`, called from `claimRun` and `getState`; `agent_runs.heartbeat_at`).
3. The migration a dev server has not applied is detected from the database file
   (`PRAGMA user_version`), not from a module-level flag on `globalThis`, and migrations only
   ever run forward. A query that still hits a missing column answers 503 "the board's database
   is behind the code — restart the board" instead of a raw SQLite 500 (`src/server/http.ts`).

**Why:** All three come out of one incident. The worker's `catch` wrote in the
chat first; the board refused that write (a dev server whose schema was behind its code), the
`PATCH` that closes the run was never reached, and the run stayed `running` — which keeps its
coder busy, so the queue stopped for half an hour with the card in In progress and nobody on it.
A single reporting step must not be able to do that, and nothing in the system was watching.
The exact reason the dev server missed `SCHEMA_VERSION 12` could not be reproduced afterwards,
which is itself the argument for keeping the version in the file: the one place a reloaded
module, a stale one and a second process all see the same.

**Rejected:** Requeuing a lost run instead of failing it (a run that already committed or moved
the card would do it twice — a failed run with the reason in the chat is honest and cheap to
retry by hand); a background timer in the Next server for the watchdog (the board has no
scheduler, and the sweep is one indexed read on a poll that already happens); keeping the
schema flag on `globalThis` and only adding the friendly error (it hides the problem instead of
fixing the half of it that is fixable); failing the run when the chat refuses the reply (the
work is done and committed by then — the summary is the right place for what was refused).

## 2026-10-08 — “Waiting for the owner” is a flag on the card, not a message in its chat

**Decision:** An agent parks a card with `ACTIONS: {"needs": "owner", "reason":
"paid_call|corpus_write|deploy|question", "text": "one line"}`. The board writes
`tasks.needs_owner_reason` / `needs_owner_text`, keeps the card where it is, cancels the runs
already queued on it and queues no new one (`enqueueRun`, `src/server/store.ts`); the card
shows a **Needs owner** badge and the feed gets a `needs_owner` line. The first chat message
from a human on the card takes the flag off (and their `@agent` then wakes the agent through
the usual path); the badge's × does the same without writing anything.

**Why:** The four things a coder must not decide alone — spending money on a model call,
writing to the corpus, deploying, and a question the repository does not answer — all used to
end the same way: a sentence in the card's chat and a run that stops. From the board that is
indistinguishable from an agent that went quiet, and the next move or mention would wake the
agent with its question still unanswered.

**Rejected:** A column for it (the card would lose its place in the queue and its coder, and
the answer usually arrives in minutes); `agent_waiting` in the feed as the whole signal (it is
written *after* the fact and says nothing about what is needed); leaving the queued runs alone
when the flag goes up (the run waiting on the card is usually exactly the one that asked);
letting an agent's message clear the flag (then the Architect could answer for the owner).

## 2026-10-08 — The card digest is derived from what the board already wrote, not stored

**Decision:** `GET /api/tasks/:id/digest` (`src/server/digest.ts`) builds its answer by reading
back the text the worker already produces: the check comes out of the latest run log that has
the worker's `[worker] check: …` / `check passed` / `check failed (exit N)` frame around it, the
commit out of the `Committed \`sha\` — N file(s):` system message. No new table, no new column,
and the module only reads.

**Why:** The facts an outside architect needs are all on the card already — just buried in
hundreds of kilobytes of log with ANSI in it. A derived view works on every card that exists
today, including the ones that ran before this endpoint did, and nothing in the write path has
to be kept in sync with it.

**Rejected:** A `checks` / `commits` table the worker posts to (the right shape if more than one
reader ever needs it, but it only answers for cards run after the migration, and it puts a
second source of truth next to the chat the humans read); parsing on the client side (every
reader would then carry these regexes, and the full log still has to travel).

## 2026-10-08 — A board can run without an architect, and the switch is one omission

**Decision:** `boards.architect_enabled` (0/1, settable in the board's details and in
`PATCH /api/boards/:id`). When it is off, `boardAgents()` in `src/server/store.ts` simply
leaves the architects out of that board's agent list — and that single omission *is* the
feature: no dispatch on Ready, no reviewer for a finished card (so the coder's hand-off moves
it to Review itself), untagged Ready cards taken by the default coder, and `@architect`
matching nobody. Switching it off also clears the architect's runs waiting on that board; a
card that was waiting for its review goes to Review, which is where the coder was sending it.
The architect stays a *member* of the board, so its old messages keep their author.

Somebody has to plan and review such a board from the outside, which is a second human in the
workspace: `POST /api/members` adds one (`createPerson`), and its messages wake agents exactly
like the owner's — `triggerMentions` only ever asks whether the author is human. See
`docs/people.md`.

**Why:** On a board whose architect is a Claude in the owner's chat, the board's architect
agent is a duplicate that runs on every Ready move, every hand-off and every mention, and each
run costs money. The rules this touches all read the board's agent list already, so taking the
architect out of that one list beats an `if (architectEnabled)` at four call sites that could
drift apart.

**Rejected:** Unchecking the architect in *Agents on this board* (`pinnedMemberIds` pins it on
purpose — it would also hide its past messages' author and lose the setting on the next save);
a workspace-wide switch (other boards keep their architect); a `review`-trigger special case
only (Ready and mentions would still cost runs); making the outside architect an agent member
with engine `stub` (it is a person — it must interrupt a busy agent and reset the agent chain,
which only a human author does).

## 2026-10-07 — One run per agent per card, and `tests/` can import `src/`

**Decision:** `enqueueRun` (`src/server/store.ts`) deduplicates per *agent and card* instead of
per trigger. A trigger for an agent that already has a queued run on the card folds into it; a
trigger for an agent whose run is in flight is dropped, unless a *human* wrote it — then one
run queues behind the running one. Two triggers opt out because the board needs them to exist
on their own: the hand-off review (`awaitingReview` reads the card's last run) and the single
automatic check retry (queued while the coder's own run is still finishing). Separately, a note
posted with `participant: false` — the Architect's dispatch reply — no longer runs
`triggerMentions` at all: it is about the queue, not about the card it lands on.

Testing it needed a way to exercise `src/server/store.ts` from `node --test`, which `src/` has
never had: `tests/ts-imports.mjs` registers a resolve hook for the `@/*` alias and extensionless
imports, Node strips the types itself, and `npm test` now runs `agents/*.test.mjs` and
`tests/*.test.mjs` together.

**Why:** Found on another board. A card was pulled into In progress (`column:in_progress` run going) and
the Architect's dispatch note for the queue contained a coder handle, so `triggerMentions`
queued `mention:902` — the same card done twice, with the second run overwriting the first's
work. An agent reads the whole card and the whole thread when a run starts, so a second trigger
arriving before or during that read tells it nothing new.

**Rejected:** Keeping the per-trigger dedupe and only stripping handles out of the dispatch
prompt (the note is free text — the next model that names a coder brings the bug back); letting
the board cancel the older run in favour of the newer (it may already have edited the working
tree); blocking *every* follow-up on a running agent (a human must be able to correct an agent
mid-run, and the check retry would never queue); a test runner or bundler for `src/`
(`node --test` plus a 20-line resolve hook needs no new dependency).

## 2026-10-07 — The commit's "before" belongs to the card, not to the run

**Decision:** The snapshot a commit is taken against lives on the card (`tasks.work_snapshot`,
written through `POST /api/tasks/:id/snapshot`, first offer wins) instead of being taken at the
start of each run. A coder run offers what it sees; it gets back the card's snapshot and commits
against that, so work done in one run and handed off in another lands in one commit. The board
clears it when a commit succeeds and when the card changes column, and only a card in In
progress keeps one at all. A hand-off with nothing to commit is no longer a log line: the card
stays in In progress and the chat says why, and a commit that does land says its short sha and
its files there too.

**Why:** Found on another board: run #501 did the work, run #505 (started by a chat
message) handed the card off, and its own snapshot already contained #501's work — so
`commitRun` saw "nothing to commit", wrote that into the run log only, and the card went through
Review to Done with no commit behind it. A per-run snapshot cannot be right here: any chat
message on a card splits the work and the hand-off into different runs.

**Rejected:** Keeping the snapshot in the worker's memory (lost on a worker restart, and runs
for the same card can span one); diffing against the card's first run's `HEAD` (the owner may
commit in between, and that still mixes in their uncommitted edits); committing on every coder
run rather than on the hand-off (half-finished work in history, and the check has not run yet);
treating "nothing to commit" as success (that is the bug).

## 2026-10-07 — Review is the owner's column; the Architect reviews in In progress

**Decision:** A card is in **In progress** for as long as anyone works on it, the Architect
included. A coder's `ACTIONS: {"move": "review"}` no longer moves the card: the board keeps it
in In progress and queues the Architect's review there (trigger `review`, `REVIEW_TRIGGER` in
`src/server/store.ts`). The Architect's verdict either hands the card back to the coder (a
mention, card unmoved) or moves it to **Review** — which now triggers no run at all. The coder
is free for its next card as soon as the review is queued: `awaitingReview()` reads the card's
last run, so a card whose review is pending stops occupying its coder and stops blocking the
cards that wait for it.

**Why:** The owner asked for the board to mean what it shows: In progress was always empty while
Review held cards with live runs on them ("Architect · queued", "Coder · thinking"), so the one
column that is meant to be the owner's last look was where all the work happened.

**Rejected:** A `tasks` column for "awaiting review" (a stored flag has to be cleared in every
path that moves, archives or re-runs a card; the last run already says it, and a verdict the
Architect forgot to act on then cannot pin the coder forever); moving the card into In progress
for the duration of a run and back (needs a "where it came from" per card, and it drags cards
backwards out of Review and Done); leaving it as a badge on the card (that is what we had).

## 2026-10-07 — A run's changes are identified by content, not by status code

**Decision:** `gitSnapshot` fingerprints every dirty path as its status code plus the hash of
its working-tree contents (`git hash-object --no-filters`), and `commitRun` commits the paths
whose fingerprint the run changed (`agents/git.mjs`). Three supporting rules there are not
optional: status is read with `--untracked-files=all` so an untracked folder is never a single
contentless `?? docs/` entry; only regular files are hashed; and a path we failed to hash gets
a value unique to that snapshot, so "could not tell" counts as changed rather than as unchanged.

**Why:** The status code alone cannot tell the owner's edit from the owner's edit with the
agent's on top — both read ` M`, so the path looked unchanged and was dropped. That was not
theoretical: commit b6c684d kept only the run's new files and left the same run's edits to
`README.md` and `agents/prompts/*.md` uncommitted, and a second run did not pick them up
either. Any "we don't know" that compares equal to another "we don't know" brings the bug
back silently, which is why the unknown marker is unique rather than a shared placeholder.

**Rejected:** `git add -A` over the tree (sweeps the owner's uncommitted work into an agent's
commit — the invariant this step exists for); diffing against `HEAD` (cannot separate the
owner's pre-existing edits from the run's); trusting the status code and re-running the agent
when something looks missing (the second run has nothing to notice).

## 2026-10-07 — Project context lives in files, not in chats

**Decision:** What the agents know about a project lives in `AGENTS.md`, `docs/status.md`,
`docs/decisions.md` and `docs/features/<slug>.md` in that project's repository. An epic is
planned into a feature file first; every child card names the file and its item, the coder
reads it before writing code and ticks its checkbox in the same change. `templates/project-docs/`
is what gets copied into a new project. Creative Space itself follows this (this file is part
of it).

**Why:** A card chat is not memory — it is per-card, unordered, and the next run starts
without it. Anything an agent has to know on its tenth run has to be readable from the
repository, by a human too.

**Rejected:** Longer role prompts (they grow with every project and still say nothing about
*this* one); feeding the agents previous chats (expensive, and the plan drowns in the
conversation around it); one big `PLAN.md` per project (no place for state vs. history vs.
per-feature detail).

## 2026-10-07 — The board commits, and only what the run changed

**Decision:** Agents never commit. The worker snapshots the checkout before a coder's run,
and after the board's check command passes it commits exactly the paths whose contents
changed during the run — the card's title as the subject, the task id and the agent in the
body (`agents/git.mjs`, `commitRun`). It never pushes and never rewrites history; if git
refuses, the card stays in In progress and the changes stay in the working tree.

**Why:** The gate has to be something the project can verify (`npm run typecheck && npm run lint`),
not the agent's own opinion that it is done. And the repository is the owner's: a commit must
not pick up their uncommitted work. The snapshot compares status codes *plus* content hashes,
because ` M` before and ` M` after cannot otherwise be told apart.

**Rejected:** `git add -A` (sweeps the owner's work into an agent's commit — this was the
behaviour, and the bug, fixed in f351c99); letting the agent commit itself (no check ran
yet, and the message style is then whatever the model felt like); committing nothing and
leaving everything in the working tree (card-by-card history is the point).

## 2026-10-08 — The event feed is a table, and it shares the `/api/events` path with the SSE stream

**Decision:** `events` is a real table (`id` growing, `at`, `board_id`, `task_id`, `type`,
`actor_id`, a one-line `summary`, `data` as JSON), written next to the `emitChange` calls in
`src/server/store.ts` and kept for 30 days (`pruneEvents` in `src/server/db.ts`, on open).
`GET /api/events?board=<key|id>&since=<id>&limit=<n>` answers with it; the same route without a
query is the SSE stream it has always been. The two things only the worker knows reach the feed
through the API it already uses: `POST /api/tasks/:id/check` now also takes exit 0, and
`POST /api/tasks/:id/commit` is new.

**Why:** The bus in `src/server/events.ts` is for a browser that is connected and refetches; a
client that is not a browser (an architect in the owner's chat, the owner's notifications) needs
"what happened since N" to be answerable later, which means stored and numbered. One path for
both reads keeps the word "events" meaning one thing from the outside, and `?board=` is what
tells them apart — an SSE subscriber never sends it.

**Rejected:** A second path (`/api/feed`) — two names for the same concept; deriving the feed
from `messages` and the run logs the way `src/server/digest.ts` does (a system message is prose
in whatever language the worker wrote it in, and it carries no type to subscribe to); letting the
worker write to SQLite directly (it talks HTTP by design, and two writers to one file is a new
class of problem); storing the check output or the run log in `summary` — the summary is a label,
the output stays in the chat and in the run log.

## 2026-10-07 — Cards created by the Architect run one after another by default

**Decision:** A batch of cards an agent asks for through `POST /api/tasks/:id/subtasks` is
chained: card N+1 waits for card N, so only the first one starts. The Architect opts out per
batch with `parallel: true` when the cards really are independent
(`src/server/store.ts`, `createAgentTasks`).

**Why:** A decomposition is a plan with an order, not a pile. Coders share one checkout, so a
parallel batch would in practice queue anyway — but with all of them marked as started and
with every later card written against code that is still changing.

**Rejected:** Starting the whole batch at once (what the first version did — cards built on
each other and conflicted); asking the Architect for an explicit `blocked_by` per card (it
got it wrong often enough that the safe default is cheaper).

## 2026-09-12 — The Architect reads, the coders write

**Decision:** Two roles, enforced by the adapters, not by the prompt: an Architect runs with
read-only tools (`Read/Grep/Glob` and read-only git for Claude Code, a `read-only` sandbox for
Codex) and plans, dispatches and reviews; a coder runs with edit and shell access and is the
only one that changes the repository (`agents/adapters/claude.mjs`, `agents/adapters/codex.mjs`).

**Why:** A reviewer that can also edit fixes what it was supposed to report, and the diff it
reviews stops being the coder's work. Read-only is also what makes an Architect run cheap
enough to spend on every move into Ready.

**Rejected:** One role doing both (no second pair of eyes, and the plan and the code land in
one unreviewable change); asking the model not to edit (a prompt is not a permission).

## 2026-10-08 — The bot confirms a certain card with 👍, a guessed one with text

**Decision:** When the owner said which card they mean — a reply to a notification, or a card
number in the text — the bot puts a 👍 on their own message (`setMessageReaction`) and sends no
text; only a *guessed* card (the last notification, neither reply nor number) still gets the
`✓ to chat BI-69 "Title"` line. A reaction Telegram refuses falls back to that line, so a
delivered message is never silent (`agents/telegram.mjs`).

**Why:** The confirmation existed to make a wrong guess visible. There is no guess to check when
the owner named the card, and a line of text after every message turns the chat into a log of the
bot talking to itself. A reaction is a receipt without a new message — no notification, no scroll.

**Rejected:** Dropping the confirmation entirely (a message the board refuses, or one that went
to the wrong card after a stale guess, would pass unnoticed); keeping the text and reacting as
well (the noise it was meant to remove, twice).

## 2026-10-08 — One automatic continuation after the turn limit, and never "unknown error"

**Decision:** A coder's run that ends on `error_max_turns` with changes in the checkout is
continued once: the worker reports the limit to the board (`turnLimit` on `finishRun`), the board
writes a system message and queues one run for the same agent on the same card
(`continue:<messageId>`, `continueAfterTurnLimit` in `src/server/store.ts`) and does not notify
the owner about that failure. One per stint in In progress, counted from the run the move into In
progress queued; the second limit in a row is an ordinary failure with a notification. The reason
itself is read out of `result`, then `errors[]`, then `subtype` (`claudeFailure` in
`agents/adapters/claude.mjs`) — "unknown error" is left only for an envelope that says nothing.

**Why:** The limit is not a breakdown: the work is on disk, and what was missing was the last
few turns. Two coder runs died this way and both reported "unknown error", so neither the owner
nor the next run knew there was anything to carry on from. The board is the only side that can
count the attempts, and the worker the only one that can see the working tree — hence the split.

**Rejected:** Raising the turn limit instead (it hides the problem one card longer and costs
quota on every run); continuing until the card is handed off (a loop that spends a plan without
anybody noticing); letting the worker queue the continuation itself (it cannot tell the second
limit from the first after a restart — the runs are in the file, not in its memory).

## 2026-10-08 — Telegram notifications carry no link, and Done is one line

**Decision:** The Telegram text and the macOS text are no longer the same string
(`notificationText` in `agents/notify.mjs`): `text` — what the bot sends — has no `http://localhost…`
link in it for any kind of notification, while the macOS channel keeps assembling the link into its
body as before. A card reaching Done is a single standard line in Telegram, `<number> moved to Done`,
without the title, the agent's `In short:` line or a count of what was glued into its window, whoever
moved the card there. The note itself is unchanged, so a Done notification is still stored as
answerable (`telegram_notifications`) and a reply to it reaches the card.

**Why:** The owner reads these on a phone, where a `localhost` link is a dead end that only makes
every notification two lines longer. Done is the one move that needs no detail — it happens because
the owner already looked at the card (their 👍, or their word to the architect, or their own drag), so
the number is all the news there is.

**Rejected:** Dropping the link on both channels (on the Mac it does open the card, right next to the
board); making the board's URL configurable for the phone (there is no address the phone can reach —
that is a tunnel, not a notification); dropping the Done notification altogether (the owner wants the
receipt, just not a paragraph of it); a second `telegramText()` function beside `notificationText` (two
places composing the same thing, and the next kind of notification would have to be added to both).

## 2026-10-13 — One card at a time: Ready waits until nothing is in In progress or Review

**Decision:** A board setting, `boards.one_card_at_a_time`, on by default — for new boards and, by
the migration's column default, for every existing one. While it is on and any live card sits in In
progress or Review, `pullNextForCoders` takes nothing and a card entering Ready queues no dispatch
(`queueHeld` in `src/server/store.ts`). The moment the last such card leaves (Done, archived,
deleted, dragged elsewhere), the same `pullNextForCoders` starts the next Ready card with a system
line naming why (*Previous card is done — …*); if nothing in Ready is a coder's yet and the board has
an architect, one dispatch is queued on the top card instead (`dispatchWaitingReady`). The rule is
column-based: *any* card in those two columns holds the queue — one parked on the owner's word,
one tagged with people only, one still waiting for the architect's review.

**Why:** The owner wants to see one card in work at a time; with the old conveyor the coder took the
next card the moment it handed one off, and the architect's review and the next card's work ran side
by side. Counting columns rather than coders keeps the rule exactly what the owner sees on the
board. The migration moves nothing: cards already in In progress or Review simply hold the queue
until they are Done, so turning it on for live boards cannot strand a card.

**Rejected:** Holding only on the coder's own cards (two cards would still be "in work" whenever one
is with the owner); queueing the dispatch on Ready and letting it run while held (an architect run
per Ready move, for a hand-out that cannot happen yet — and the hand-out it writes may be stale by
the time the queue frees); a per-card "waiting" flag stored in the database (the state is derivable
from the columns, so the UI derives it too and nothing can go out of sync).

## 2026-10-13 — Scope rich-text keys by text chunk offset

**Decision:** Prefix mention and plain-text span keys with the chunk's source offset, passed
from `renderRichText`; keep a default prefix for standalone `renderMessageText` calls.

**Why:** Chunks on either side of inline images share one sibling array, so their local
indices need separate namespaces even when mentions repeat.

**Rejected:** Keys based on text plus a local index, which collide across chunks; changing
image keys, whose source offsets already make them unique.

## 2026-10-13 — The coder writes the subject of the board's commit

**Decision:** A coder's hand-off carries `"commit": "<subject>"` in its ACTIONS line; the worker
uses it as the commit subject, with the body unchanged (`Creative Space task #<id>`, `Agent: <name>`).
The prompt asks for English, imperative mood, at most 72 characters, no full stop, the change
rather than the task, no card number. The parser collapses whitespace and refuses an empty or
over-long subject (logged as a problem); then the card's title, cut to 72, is used as before.

**Why:** Cards are written by the owner as short tasks in Russian, so a history titled by them
reads as a to-do list. The coder is the one who knows what the change actually is.

**Rejected:** Cutting an over-long subject to 72 (a subject cut mid-word is worse than the title);
enforcing the style rules (imperative, no full stop) in code — they are judgement, the prompt
carries them; a second model call to write the message (a paid call per hand-off).

## 2026-10-18 — One card at a time can release the queue on the Architect's approval

**Decision:** A second board setting beside *One card at a time*, `boards.queue_release` TEXT —
`'done'` (default, and what the migration gives existing boards) or `'review'`. With `'review'`,
`queueHeld` counts only In progress: the card reaching Review frees the queue and the next Ready card
starts through the same path as Done, with *Previous card is in Review — …*. A coder's hand-off does
not free it, because the card stays in In progress until the Architect's verdict moves it; a card the
owner drags back from Review to In progress holds it again. The Board details select shows only while
*One card at a time* is on; the UI's *Waiting for the current card* uses the same column set.

**Why:** The owner wants to leave the board running and review a batch in Review later, without
giving up the guarantee that only one card is in work at a time. Keeping it column-based (as the
first decision) means no new state: the rule is still what the board shows.

**Rejected:** A boolean (`review_holds_queue`) — a named mode leaves room for another release
point without a second migration; releasing on the coder's hand-off (the architect's review and the
next card's work would run side by side again, which is what the switch exists to prevent);
switching *One card at a time* off for this (Ready would then run in parallel with In progress too).

## 2026-10-22 — Only cards of agents hold the one-card queue

**Decision:** `queueHeld` counts a card in In progress / Review only if at least one of its
assignees is an agent (`members.kind = 'agent'`). A card with no assignees or with people only
stays there as long as it likes and the next Ready card still starts; moving it never announces the
queue free or queues a dispatch. The board's *Waiting for the current card* uses the same rule.

**Why:** The queue is the coders' slot in the repository. On UG the owner's own card (a sheet in
Figma) in In progress kept a coder's Ready card from starting until it was pushed back to Backlog —
people and coders are meant to work in parallel.

**Rejected:** A per-card "doesn't hold the queue" flag (one more thing to remember to set, when the
assignees already say it); counting by column alone, as before.

## 2026-10-22 — Browser tab activity follows the current board

**Decision:** Derive tab activity from running tasks across all columns of the current board,
using the existing state load and SSE refresh. Capture favicon attributes, temporarily replace
the favicon with a green SVG dot, and restore it when idle or unmounted. Leave the title unchanged.

**Why:** Activity stays visible with any card open, without another request loop.
An SVG data URL needs no image loading or canvas work.

**Rejected:** Polling for runs separately, hardcoding the title, or using only the open card's run.

## 2026-10-22 — Keep the tab activity indicator in the favicon only

**Decision:** Remove the activity marker from the tab title while keeping the green favicon
and its restoration unchanged.

**Why:** Max Shakurov requested keeping only the green icon.

**Rejected:** Showing activity in both the title and favicon.

## 2026-10-23 — The run timeout is the agent's setting, and a timeout is its own status

**Decision:** `members.run_timeout_minutes` (5–180, NULL = the worker's `CS_RUN_TIMEOUT_MS`, 20 min)
sets how long one run of that agent may take. The worker owns the deadline — its own AbortSignal next
to Stop's, covering the engine call only — and a run killed at it closes as status `timeout` with a
plain system line, not as `failed` with the CLI's last output. The feed still records it as
`run_failed` (with `timeout: true`), so the owner is notified as "Run timed out". The board's
watchdog gives each run its agent's limit + 5 min before calling it lost.

**Why:** A 20-minute cap killed a Codex run on high effort mid-card (UG-27): the work stayed in the
tree, but the chat said "codex exited with -1" over a build log, which read like broken code. NULL
as the default keeps every existing agent exactly as it was.

**Rejected:** Storing 20 on every agent (the env default would stop applying); a new feed event type
for timeouts (the notifier and digest would each need to learn it for one wording change);
continuing a timed-out run automatically like the turn limit (an hour-long run twice is the owner's
call).

## 2026-10-23 — An agent's answer wakes the agent that asked, without a tag

**Decision:** When an agent posts on a card while its run was started by another agent's mention
(`mention:<id>`, the author of `<id>` is an agent), the board queues a run for that asker with
trigger `reply:<answerId>` and writes "X answered — Y continues." The answer's text is not touched.
Guards: one wake-up per question (a run on `reply:` of a later message by the same answerer
exists → none); at most 3 `reply:` runs per card in an hour, the 4th answer sets `needs_owner`
with a new board-only reason `agents_loop`. An answer that tags any human member wakes nobody and
sets `needs_owner` (`question`) itself; its feed line is skipped when only the owner is tagged,
since `owner_mentioned` already notifies. Lives in `addMessage` → `wakeAsker` in the store.

**Why:** UG-26: the architect answered the coder in 14 seconds without `@coder`, the coder never
woke, and the card sat 40 minutes with the answer in it. Waking is by mention only and agents write
answers *to* someone, not *at* them — a rule in the prompt would fail the same way again.

**Rejected:** Telling the architect's prompt to always tag the asker (the failure mode is the model
forgetting); rewriting the answer to add the tag (the card spec forbids changing it); a new column
to link a `reply:` run to its question (the join over `messages` answers it without a migration).

## 2026-10-26 — The card's "before" snapshot survives Ready and Review; leftovers are reported

**Decision:** `updateTask` clears `tasks.work_snapshot` only when the card moves to Done or
Backlog (and a landed commit still clears it, as before) — no longer on every column change.
After a commit the worker runs `git status --porcelain --untracked-files=no` and posts the tracked
files still modified as a system message on the card.

**Why:** UG-39: run 1 wrote six files and asked the owner; the owner confirmed the bigger scope by
moving the card to Ready, the move wiped the snapshot, run 2 took a fresh one with the six files
already dirty and the commit left them out, silently. Ready ↔ In progress ↔ Review is the same
work; only Done or Backlog ends it.

**Rejected:** Keeping the snapshot forever until a commit (a card closed without one would later
count the owner's edits as the agent's); failing the hand-off when tracked files remain (they may
be the owner's own uncommitted work — the board cannot tell, so it names them instead); listing
untracked files too (build output and scratch files would drown the real ones).

## 2026-11-02 — What an archived board is

**Decision:** An archived board (`boards.archived = 1`) is hidden from *Your boards* and listed
under *Archive* with a *Restore* button; nothing on it is deleted, its key stays reserved and a
direct link to its card still opens. `queueHeld` returns true for it whatever its one-card setting,
so no coder takes its Ready cards and no dispatch is queued; restoring it frees the queue with
*The board is back from the archive — …*. `updateBoard` refuses to archive a board with a run
queued or running on it.

**Why:** BI-109: before this the flag was read only by notifications and Telegram — an "archived"
board stayed in the sidebar and kept working. `queueHeld` already gates both pulling and dispatch,
so one check there stops the whole conveyor. A live run would carry on where nobody sees it.

**Rejected:** Cancelling the live runs on archive (it would kill an agent mid-change and leave a
dirty tree); hiding the board from the API's `getState` (the deep link and the Restore row need it);
gating every run trigger separately — a mention or a hand move on an archived board still starts its
run, since it only happens when the owner opens that board on purpose.

## 2026-11-04 — Loop detection instead of a low turn limit

**Decision:** The turn limit is 200 for every role (still per agent); a run is stopped by the
worker watching its streamed events (`agents/loops.mjs`): the same call with the same arguments 3
times in a row, the same call failing with the same error 3 times (a hash of the whole output with only
its timings normalized, so a test's duration does not make it a new error but "fail 3" after
"fail 5" or "got 4" after "got 5" does — an earlier version kept the last 600 characters with
every digit out, which on `node --test` is the summary and matched any failure; an output Claude
Code cut — `BASH_MAX_OUTPUT_LENGTH`, marked `[N lines truncated]` — does not count at all, since
the cut may leave only the start and drop the failures `node --test` prints at the end), or 25 calls in a row that only repeat calls made earlier
in the run with no file changed. "No new tool kind" from the card is read as "no new call": the
idle counter resets on any call not made before and on a successful edit. A hit kills the CLI,
closes the run as failed with `loop` (and `turnLimit` when the tree changed, for the one
continuation) and posts a system line. The run log gets one `→ <call>` line per step; the raw
stream stays out of it. Board-level loops reuse `needs_owner` reason `agents_loop`: a new
`tasks.review_rounds` counts hand-offs that came back (check failed, the Architect's review
mentioning the coder, Review → In progress); the 4th by an agent stops the card. A human moving the
card back counts but stops nothing; a human releasing an `agents_loop` flag, an escalation to a
new coder, and Done/Backlog reset it. The 6-message agent chain now sets the flag instead of only
writing a line (`agents_paused` is no longer recorded), and counts from the last hand-off.

**Why:** BI-120: the Architect hit 20 turns reading code for a dispatch while a stuck coder could
burn all 80 of its own. A dispatch reads forty different files with two or three tools — a rule on
the tool *name* would stop it at turn 25. A flag rather than a chat line, because the line left the
card looking idle with no badge and no notification.

**Rejected:** Counting repeats per tool name (stops honest reading); raw stream in the run log
(every file read lands in the database); a new `review_loop` reason (one board-only reason for
"agents going round" is enough, and the flag's text says which); counting rounds from the event
feed (the Architect's "changes requested" leaves no event of its own).

## 2026-11-04 — The Architect supervises stuck cards; Autopilot closes approved ones

**Decision:** The store wakes the board's Architect on a coder's card that got stuck (failed,
turn limit, loop, timeout, lost run, check failed after its retry with no tier above, or a coder
that stopped without a hand-off or a question to a human) with a `supervise:<runId>:<reason>`
run, once per stuck run. Its options are a hint by mention, `reassign` to any other coder on the
board, a split, or the owner; a run that does none of them flags the owner. The cap is in the
store, not the prompt: `tasks.supervisions` counts interventions, and the third stuck time goes
to the owner directly. Autopilot is a board flag the store applies to the Architect's
In progress → Review move only as the verdict on a hand-off — the one move with a passed check and
a commit behind it: the running run is the review (`trigger = 'review'`), or a review of the same
Architect is still queued on the card. The second case is every fix round: the coder's answer
queues a `reply:` wake before its hand-off queues the review, `claimRun` takes the older run, and
the verdict comes from the reply run. (Merging the runs was left for later to keep this card's
review flow as it was, not on the merits — BI-125 did it, see the entry below.) The same move from a supervise run, a mention or the owner's message with no review
pending stays in Review, and a human moving a card to Review is untouched. Since the
Review notification is skipped, the Done one is marked (`card_moved.data.autopilot`) and carries
the title and the Architect's line. A supervise run moves a card only to park it in Backlog after
a split whose cards were created (a refused split goes to the owner), and any reply with an
ACTIONS line wakes nobody it names — only a hint does.

**Why:** BI-124: a stuck card waited for whoever happened to look. The Architect already reads
the code and the chat; the board only has to wake it and stop it from going round.

**Rejected:** Reusing `escalate` (it allows only one tier up, once — a stuck card may need a
sideways move or a cheaper coder); counting interventions from the runs table (a hint is a
mention, not a run of its own kind, and the count must reset on a human's answer); Autopilot as
a different column target in the Architect's prompt (the board, not the model, should decide).

## 2026-11-04 — A worktree per card: the worker makes it, the board lands it

**Decision:** With *Parallel work* on, the worker makes the card's worktree at the start of a
coder's run on a card in In progress (not the store at the move): making one and running the
setup command (`npm ci`) can take minutes, and the worker already runs the check and the commit.
The board records it on the card (`tasks.worktree_branch / _path / _base`), and from then on every
run on the card works there, whatever the switch says later. Landing is the store's, synchronously
at the move that releases the card (`landIfReleased`, the same point that frees the queue): the
next card that move starts is cut from a main branch that already holds this one, and no worker has
to be running for a Done to land. The merge runs in the board's own checkout and only when it is on
the card's base branch; a refused merge is aborted and changes nothing. `worktree remove` is never
forced — leftover uncommitted files keep the worktree, and the chat says so. A setup command that
fails takes its fresh worktree back, so the next run runs it again.

**Why:** BI-115, Parallel 1/5 — each card's work in its own copy before more than one coder runs
at a time.

**Rejected:** Creating the worktree in `updateTask` (git and `npm ci` inside a request, and a card
can enter In progress with no worker around); merging in the worker after it sees the move (a
Done with the worker down would never land, and the next card could start from an old main);
`git worktree remove --force` (it would quietly delete work nobody committed); worktrees inside the
repository (its status, search and build would all see them).

## 2026-11-04 — A blocker with a worktree stays open until it lands

**Decision:** `isBlocked` counts a blocker that has a worktree as finished only once it is
released (`worktreeReleased`: Done, or Review with `queueRelease` 'review') — not at its coder's
hand-off and not in a Review that still holds the queue. A blocker without one keeps the old rule.
The card's "after …" label follows the same rule.

**Why:** Until it lands, the blocker's commits are on its branch only; a dependent card started
earlier is cut from a main without them (a feature file the next card should read and tick is not
there, and the two branches conflict later). The pull runs inside the releasing move and the merge
right after it, before the worker can claim the dependent card's run.

**Rejected:** Cutting the dependent card's worktree from the blocker's branch (stacked branches
to land in order — that is Parallel 4/5 territory, if ever).

## 2026-11-04 — Several coders at once: slots per board, checkout runs stay alone

**Decision:** `Board.maxCoders` (1–3, default 2, ignored with Parallel work off) is used twice:
`claimRun` lets a coder run start beside others in the same repository only when it and every
running one work in a card's worktree (`runsInWorktree`, the store's copy of the worker's
`plannedWorktree`) and fewer than that many run; and `queueHeld` holds the queue once that many
agent cards are in work. The cap is the claiming board's, counted over every board sharing the
repository. A card's worktree takes one coder run at a time (a card tagged with two coders queues
two runs). Where a run works is recorded on it when it is claimed (`agent_runs.in_worktree`), and
a running run is judged by that, not by its card's state now.

**Why:** Two runs in one checkout trample each other's files, so a card without a worktree (one
from before the switch, a board with no repository) keeps the old one-at-a-time rule in both
directions. The same goes for two runs in one worktree: whichever hands off first would commit
the other's half-finished edits. Recording the place on the run closes the edge where Parallel
work is switched on under a checkout run: its In progress card then reads as a worktree card,
and without the record a second coder could start beside it. Reusing `queueHeld` keeps
`queueRelease` meaning the same thing per card.

**Rejected:** A separate per-repository setting (boards sharing a folder are rare, and the owner
sets things per board); letting checkout runs go beside worktree runs (safe for git, but a
merge on release then lands under a coder working in that very checkout).

## 2026-11-04 — Parallel dispatch is a prompt section, not a new ACTIONS field

**Decision:** With Parallel work on and *Max coders at once* above 1, a dispatch run gets
`agents/prompts/dispatch-parallel.md` after `dispatch.md`, filled with that limit (`claimRun`
passes it as `RunContext.board.maxCoders`). With one slot nothing runs side by side and
`dispatch.md` is right as it stands, so the section stays out. It tells the Architect that
unblocked cards really run side by side, each in its own worktree; cards that build on each other
or touch the same files go into `blocked_by` — a card already In progress in its own worktree
included, the likeliest collision — clearly separate ones stay free, and when unsure the
later card waits. The chat note gets one line on what runs together and what waits. The ACTIONS
line is unchanged — `blocked_by` already is the whole "parallel or not" decision, since the store
starts every unblocked card it has a coder slot for.

**Why:** The store already enforces the slots and the waits (BI-116); what was missing was the
Architect knowing its `blocked_by` now decides concurrency, and `dispatch.md` saying the opposite
("the queue is sequential per repository anyway"). A separate file keeps that text out of the
prompt on boards with the switch off.

**Rejected:** A `parallel` group field in ACTIONS (a second way to say what `blocked_by` already
says); rewriting `dispatch.md` with conditionals (the prompt files have no templating beyond
plain placeholders).

## 2026-11-04 — A merge conflict on landing goes back to the card's coder, once

**Decision:** When landing a card's branch stops on a conflict, `landWorktree` reads the
conflicting paths before the abort, and the store (`sendBackForConflict`) moves the card back to
In progress, lists the paths in the chat and queues a `conflict:<messageId>` run for its coder — a
coder tagged on the card, else the last coder that ran on it. The *worker* starts
`git merge --no-commit --no-ff <base>` in the card's worktree, after the run's snapshot, and the
agent only edits the files. The commit step, seeing `MERGE_HEAD`, commits the whole index (with
no file changed, too) and refuses while a path is unmerged or still has a conflict marker
(`git diff --cached --check`). `tasks.merge_conflicts` counts the rounds: a second conflict flags
the card for the owner (`question`); landing clears it, and so does a human answering. Any other
refusal (wrong branch, a dirty checkout) stays as it was — a message and nothing moves. Other
cards' worktrees are never touched: each catches up with main at its own merge.

**Why:** BI-118, Parallel 4/5 — two cards editing the same lines must both land. The merge is the
worker's because a worktree's git directory lives in the main repository's `.git`, outside what a
sandboxed engine (Codex, `workspace-write`) may write; editing files works for every engine.
Committing the whole index is the only way git concludes a merge, and in a card's worktree
everything in it is the card's. The markers check stands in for the `git add` that would
otherwise mark a half-resolved file as resolved.

**Rejected:** Asking the agent to run `git merge` (fails under the Codex sandbox, and a clean merge
would commit on its own); rebasing the branch onto main (rewrites the card's commits and needs a
commit per step); updating every open worktree as soon as a card lands (moves files under a
coder mid-run); a separate needs-owner reason (the owner's call here is a plain question).

## 2026-11-04 — Abandoned cards drop their worktrees by force; a clone or nothing for node_modules

**Decision:** A card that is archived, deleted or moved back to Backlog has its worktree removed
with `--force` and its branch deleted with `-D`, at that move (or when the run working in it ends);
its chat names the commit the branch pointed at. The worker's start-up sweep removes every `cs/*`
branch and its worktree that no card needs — kept: a card with a run, and a live card (not archived,
not in Backlog) that records the branch or sits in Ready / In progress. With no setup command, a
fresh worktree gets `<repo>/node_modules` cloned copy-on-write (`cp -c` on macOS, `--reflink=always`
elsewhere), only when it is git-ignored; a disk that cannot clone gets none. The run log reports the
worktree's disk use, not counting the clone.

**Why:** BI-119, Parallel 5/5 — after a day of parallel work no stale worktrees or branches. Moving a
card out of the work is the owner putting it aside; refusing to clean up because of unmerged commits
would leave exactly the leftovers the card is about, and the sha in the chat makes it reversible. The
sweep runs in the worker because its start is the one moment no run can be in flight (after the
requeue). Ready / In progress are kept without a record because the worker may be making the
worktree that moment.

**Rejected:** A non-forced removal that keeps unmerged branches (they pile up); sweeping from the
board's own start (Next starts lazily, and a run may still be in flight); a full `cp -R` or
symlinked node_modules when cloning fails (gigabytes per card; a symlink lets a coder's install
change the main checkout's packages).

## 2026-11-04 — A forced cleanup saves uncommitted work first; the sweep only takes the board's names

**Decision:** Before `dropWorktree` removes a card's worktree by force, it commits whatever
`git status --porcelain` shows onto the card's branch, as the board: `add -A` (ignored files stay
out), `--no-verify`, `commit.gpgsign=false`. If that commit fails, nothing is removed. The sha the
branch ends on goes into the card's chat. For a deleted card it goes into the server log, and for
the start-up sweep into its result and the worker's log line. The sweep only considers branches
the board names, `cs/<board key>-<n>` for the boards on that repository or `cs/<card id>`, plus
branches recorded on archived or Backlog cards. An archived card that is released (Done, or
Review where that releases) and whose branch is not in its base keeps the branch and the worktree.
The node_modules clone first probes one file with `COPYFILE_FICLONE_FORCE`. Node on macOS answers
that with ENOSYS even on APFS, so there the probe instead requires the same volume (`dev`) and an
APFS `statfs` type — the type of `/`, since macOS numbers filesystem types as they register. A
probe that fails skips the clone with "the disk cannot clone". `dropWorktree` acts only on a
folder inside `<repo>.worktrees/` (compared as real paths, the folder taken next to the repository
path as given — where `worktreePlan` makes it — so a project opened through a symlink still
counts). Any other folder — the main checkout,
or a worktree the owner made, even on a board-named branch — gets `dropped: false, foreign`
before the save: nothing committed, nothing removed, the branch kept. The sweep skips those
quietly.

**Why:** BI-119 review. The worker commits only at hand-off, so a card parked between hand-offs
had its work wiped and the sha in the chat pointed at the base. `cp -c` falls back to a full copy
off APFS (man cp). A sha nobody wrote down brings nothing back. A blanket `cs/*` sweep deleted
branches the board never made. Archiving approved work whose landing failed must not destroy it.

**Rejected:** A `git stash` before removal (a stash is tied to the main checkout and easy to lose);
refusing the cleanup while the tree is dirty (the leftovers pile up again); a new feed event type
for deleted cards' shas (the server log is enough for a card nobody can open any more); probing
only with FICLONE_FORCE on macOS too (it would turn the clone off everywhere there); a fixed
APFS id 0x1a (not stable across macOS boots); trusting `git worktree list` for the folder (it
lists the owner's checkouts too, and the save would commit their work as the board).

## 2026-11-04 — One Architect run per fix round, and its send-back is a round

**Decision:** A coder's hand-off (`updateTask`, the `reviewer` branch) cancels the Architect's
`reply:` runs still queued on the card before it queues the review: the review reads the same
thread, so the answer is not lost. A `reply:` run that had already started gives the verdict, so
`triggerMentions` counts the Architect's send-back toward `MAX_REVIEW_ROUNDS` whenever it is the
verdict on a hand-off (`reviewingHandOff`), not only from the run whose trigger is `review`; when
the send-back came from another run, the review still queued behind it for that Architect is
cancelled. An approval already cancels it (`cancelQueuedColumnRuns`). A coder's answer that does
not hand off still wakes the Architect with `reply:`.

**Why:** BI-125, found in BI-124's review. Every fix round cost two Architect runs on one commit
— the reply run, whose prompt does not say it is a review, then the review reading the same
commit again — and a send-back from the reply run never counted as a round, so the review cap
did not hold for a coder that answers before handing off. This revises the BI-124 entry, which
kept the two runs only to leave that card's review flow alone.

**Rejected:** Queueing the review ahead of the reply run (two runs still, just reordered);
dropping the `reply:` wake for coders altogether (an answer that does not hand off must still
reach the Architect); cancelling the reply run once it is running (the Architect's verdict is
already being written).

## 2026-11-04 — App mode has no implicit repository or example board

**Decision:** Electron sets `CS_APP=1` for the board and worker, packaged or unpackaged. Seed
only the owner and agent profiles in this mode; keep dev's sample board and preserve existing
app databases. Require an absolute, accessible project directory for app boards with agents.
Share the folder guard between the store, worker and adapters; reject app bundles and symlinks
into them. Guard enqueue and claim (including old queued runs), write a card note on refusal,
and validate before the worker's snapshot, worktree setup, check or commit. Dev retains its
implicit checkout. New-folder starter runs default off; existing-folder runs default on.
Prompts ask for missing project documentation without referring to repo-only templates.
Runtime filesystem paths opt out of Turbopack tracing; retain the packaging allowlist.

**Why:** BI-127 first-DMG testing found seeded sample cards and agents falling back into the
app bundle or worker's home directory. A store-only guard would not cover stale contexts or
an adapter called directly. Runtime user files must not be copied into standalone output.

**Rejected:** A hidden per-board working folder (the Architect chose an explicit project
folder); shipping/copying templates now (belongs to onboarding); removing the build cleanup
step (it is still defense against accidental inclusion of data or secrets).

## 2026-11-04 — The Mac app tells about updates; it does not install them

**Decision:** The app polls the latest GitHub Release (launch, then every 6 hours; override with
`CS_UPDATE_URL`), compares versions numerically, and offers the release's `.dmg` in the browser:
one Download / Later dialog per new version (macOS notifications reach only signed apps) plus a menu item, and "Check for Updates…" on demand. A 404
means up to date; a network error is silent in the background and "Couldn't check" from the menu.
The version bump is a small script that edits package.json/package-lock.json only.

**Why:** Silent "Restart to update" (electron-updater) needs a signed and notarized app; the
build is unsigned. Do it once signing exists. A plain download link works unsigned.

**Rejected:** electron-updater now (fails on an unsigned app); a banner inside the board UI
(the update is the app's concern, not the board's); `npm version` (it commits and tags, and
releases are the owner's call).

## 2026-11-04 — App Telegram credentials belong to the app, not the developer's environment

**Decision:** Electron supplies `CS_APP_DATA_DIR` from `app.getPath("userData")` and clears
inherited Telegram variables for both children. Under `CS_APP=1`, the worker skips `.env`
entirely and both Telegram directions read only `telegram.json` in that directory, failing
closed when missing or invalid. Settings → Notifications saves that file atomically with
0600 permissions, returns only connection status/chat ID, and removes it on disconnect.
The worker refreshes both directions when credentials change, discarding old pending notices
instead of sending them to a new chat; macOS remains available regardless of Telegram.
Terminal/dev runs retain `.env` loading and shell-variable precedence. Packaging retains its
existing standalone allowlist, excluding `.env` and runtime data from the bundle.

**Why:** The launcher used to inherit the entire shell environment, and the notifier read
`PROJECT_ROOT/.env` unconditionally (including the checkout for unpackaged Electron).
Next also loads `.env` into its server environment. A single app-only credential source
prevents all of these sources from implicitly connecting the developer's personal bot.

**Rejected:** Clearing only the launcher environment (the dotenv path remains); merely
skipping dotenv (inherited tokens remain); storing credentials in the repo or bundle;
returning the saved token to prefill the browser form; requiring an app restart to disconnect.

## 2026-11-04 — Explicit board architect selection

**Decision:** Store a nullable `boards.architect_id`, default new boards to the first active
architect, and migrate existing boards from their member order. Keep the existing on/off
switch independent of the selection. Only the owner is pinned globally; the selected
architect is pinned to its own board. Other architects are consulting members. All board
orchestration and approval use the selection, also named in the agent prompt.

Changing the selection transfers queued board duties and waits for running architect work
on that board to finish. Removing an architect or changing its role falls back to the first
remaining architect; none means disabled behavior, including releasing pending reviews and
flagging unresolved escalation/supervision for the owner. Active cards record the change.

**Why:** A workspace-wide first architect serializes otherwise independent boards and makes
additional architects ineffective. Explicit ownership removes ambiguity while preserving
existing boards, agent concurrency limits, pending work and the Architect-off workflow.

**Rejected:** Picking by member order (fragile and invisible); pinning every architect to every
board (unnecessary membership); allowing the selection to change during an architect run
(the old run could still act); cancelling queued reviews on replacement (strands finished work).

## 2026-11-04 — Board details from the header; the app menu reaches the page by window event

**Decision:** The board header gets a ⋮ that shares one `BoardMenu` with the sidebar. The app's
File → Board Details… (⌘,) calls `webContents.executeJavaScript` to fire a `cs:board-details`
window event; the page listens for it and for the keypress, and ignores both while a board
dialog is open. The sidebar ⋮ keeps its look.

**Why:** The app has no preload or IPC, so a window event is the smallest bridge. The sidebar
button was never hidden, so dimming it would only make it harder to find.

**Rejected:** A preload with IPC (new surface for one menu item); a low-opacity sidebar ⋮.

## 2026-11-23 — Max coders at once goes to 6; one cap for the whole machine

**Decision:** `Board.maxCoders` takes 1–6 (`MAX_CODERS` in the store; default still 2, stored
values untouched). The scheduler is unchanged in shape: `repoBusyForCoder` still counts running
coder runs per repository against the board's slots, a card's worktree still takes one run, merges
still happen one at a time in the board process (`landWorktree` is synchronous), and "waits for"
is still `isBlocked`. New is `machineCoderCap()` — `CS_MAX_CODERS`, default 6, read on every
claim — checked first in `repoBusyForCoder` over every board and repository: a coder run waits
(stays queued) rather than starting beyond it. The Mac app runs with the default; `npm run up`
takes the variable from the shell.

**Why:** The owner wants more than three cards in flight on one board. Nothing in the worker or
the store assumed three — the number lived only in the validation, the select and the docs — but
four boards at six each would be twenty-four coder processes each running the project's tests,
so the raise comes with a ceiling.

**Rejected:** A cap in the worker (it would need the board's settings and a second source of
truth); counting pending merges (they are serialised by being synchronous already); a migration
of stored values (none needed).

## 2026-11-24 — A coder run on a Parallel-work board starts in In progress; a held run says why

**Decision:** `claimRun` takes a coder's card into In progress before marking the run running
when the board has Parallel work and a repository (`takeCardToWork`, the same move a mention in
Ready already made, now for any column before Review). So `runsInWorktree` and the worker's
`plannedWorktree` agree: the run gets a worktree, never the board's checkout. A queued coder run
carries `AgentStatus.waitingFor` — `runWaitReason`, the rules of `repoBusyForCoder` in words —
shown on the card; `Board.codersWaiting` counts held runs for the header.

**Why:** On Motion Lab (2026-11-24) a coder mentioned on a card still in Backlog was claimed
before the card moved, so the run worked in the checkout and held two other coders' runs for
twelve minutes while the header said *Coders 1/6*. The checkout rule itself is right — two
writers in one directory would commit each other's edits — the card just must not be there.

**Rejected:** Refusing to claim until the card is in In progress (a Backlog mention would wait
for ever); making a worktree for a card in any column (Review and Done cards must keep their
branch, or none); a reason on Ready cards only (`queueWaitNote` — the held run is in In progress).

## 2026-11-25 — Design briefs: a title prefix the board honours, not an instruction the Architect must obey

**Decision:** A card whose title starts with `[Design]` (`isDesignBrief`) wakes no agent by
itself: `enqueueRun` drops every trigger but an explicit `mention:` on it, `triggerColumnRuns`
writes nothing, the dispatch context and `dispatchWaitingReady` leave it out, `pullNextForCoders`
steps over it, and `queueHeld` does not count it as a card in work.

**Why:** The owner keeps design briefs on Motion Lab beside the coding cards and talks in them
with a designer outside the board. An instruction telling the Architect to "do nothing and end
the run" still costs a run on every untagged message and every move — the model has to start to
read the instruction. Not waking it is the only way to spend nothing.

**Rejected:** A card flag or a label (another thing to set; the prefix is already how the owner
marks them); blocking explicit mentions too (then nobody could ask an agent a question in a
brief on purpose); a per-board setting (the prefix reads the same on every board).

<!-- Copy the block above for the next entry, above this line. -->
