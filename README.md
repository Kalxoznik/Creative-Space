# Creative Space

A kanban board where you and your coding agents work on a project together. An **Architect**
plans tasks, sorts the queue and reviews the work; **coders** implement cards in your
repository and commit. You add cards, talk to the agents in each card's chat, drag cards
between columns, and the board shows who is doing what. Everything runs on your own computer
and is stored in one SQLite file — no accounts, no cloud, no keys to paste. The agents run on
the Claude Code or Codex CLI you already have installed, on your own subscription.

## What you need

- **Node.js 22.13 or newer** (24 recommended) — the board uses Node's built-in SQLite.
- **Claude Code** installed and logged in (`npm i -g @anthropic-ai/claude-code`, then run
  `claude` once and log in). Optional: **Codex CLI** (`npm i -g @openai/codex`, `codex login`)
  if you want to run the Coder on Codex.
- A project in a **git repository** for the agents to work in. The Coder commits its work
  (it never pushes and never rewrites history).

## Quick start

```bash
git clone https://github.com/Kalxoznik/Creative-Space.git
cd Creative-Space
npm install
npm run up
```

`npm run up` starts the board and the agent worker together, opens
http://localhost:43123, and one Ctrl+C stops both. (On a Mac you can also double-click
**Creative Space.command**.)

The first launch asks for your name — that's the whole setup. You start with one example
board, **Creative Space**, which tracks this tool itself (its folder is the clone you are
running) with a few ideas in Backlog — drag one into Ready to watch the agents work.
For your own project, create a board: give it a name, point it at the project folder and
choose which agents take part. If the folder has no `CLAUDE.md` yet, the dialog offers to add a
first card where the Coder reads the project and writes one, so the agents know the
stack, the structure and how to run and check things on every run after that.

Every agent run spends quota on the plan behind your CLI. To try the loop without any
model calls: `CS_AGENT_MODE=stub npm run up`.

## Agents

**Agents** in the sidebar is where agents are created. Each agent is a member of the
workspace with a role — **Architect** or **Coder** — and its own configuration: which CLI
runs it (Claude Code or Codex), the model, the **effort** level (Low / Medium / High / Max —
`--effort` for Claude Code, `model_reasoning_effort` for Codex, Max = `xhigh`), a turn limit,
a one-line description of what it is good for, and extra instructions appended to its role
prompt. You can have several coders — say a cheap, fast one for small UI fixes and a
high-effort one for logic — and the Architect picks between them by their descriptions.
Per board you choose which agents take part (Board details in the board's menu). The worker
picks up new and changed agents without a restart.

## How work flows

```
Backlog  →  Ready  →  In progress  →  Review  →  Done
 drafts     queue       coders        Architect   you
```

- **Backlog is yours.** Nothing happens to a card until you move it to Ready.
- **Ready is the queue, and the Architect sorts it.** When a card enters Ready on a board
  that has an Architect, the Architect reads the whole queue and decides which coder takes
  which card, in what order, and what has to wait for what (a card marked *after “…”* stays
  in Ready until that card reaches Review). A card too vague to implement is sent back to
  Backlog with a question. On a board without an Architect, untagged Ready cards go to the
  board's first coder as they are.
- **Coders take their cards one after another.** Whenever a coder is free — nothing running,
  none of its cards in In progress — its top Ready card that is not waiting for anything moves
  to In progress by itself and its run starts. Coders on one repository never run at the same
  time: they share one checkout, so a second coder's run waits for the first to finish. Boards
  on different folders do run in parallel.
- **Drag a card into In progress** to start it right now: the agents tagged on the card
  wake up (an untagged card goes to the board's first coder; a card tagged with people only
  wakes nobody).
- **When a coder is done** it moves the card to Review and takes its next Ready card.
  If it stopped to ask a question, the card stays in In progress and that coder waits for you.
- **Check before Review.** A board can have a check command (Board details, e.g.
  `npm run typecheck && npm run lint`). The worker runs it in the project folder when a coder
  hands a card to Review; if it fails, the card stays in In progress with the output in its
  chat and the coder gets one retry. After that a human looks.
- **Stop** in a card's panel kills the agent's run; the card stays where it is.
- **Review** wakes the Architect, who reads the actual `git diff` and gives a verdict.
  Moving to Done is yours.
- **@handle** in any card's chat wakes that agent. Agents can talk to each other, but after
  six agent messages in a row the thread pauses until a human writes.
- Columns are recognised by their names (Backlog, Ready / To do, In progress, Review,
  Done) and can be renamed or reordered; a board without a Ready list starts nothing by
  itself, but after a hand-off the coder continues with the next Backlog card.

Every dispatch is one Architect run, so on a board with an Architect a card moved to Ready
costs a (short, read-only) model call before the coder's. The pill in the header shows whether
the worker is running (and, under Agents, which CLIs it found — a missing Claude Code or Codex
is reported there instead of failing silently). Done cards can be archived from the list menu
and restored from *Archived* in the header. Images pasted into a chat or a description are
saved to `uploads/` and passed to the agents as file paths.

## How it works

```
browser ── /api/* ──▶ Next.js route handlers ──▶ src/server/store.ts ──▶ data/board.db (SQLite)
   ▲                                                    │
   └──────────── /api/events (SSE) ◀────────────────────┘
                                                        ▲
agents/worker.mjs ── claim / log / reply / move ────────┘
```

- `src/server/db.ts` — opens `data/board.db` (`node:sqlite`, no native deps), creates the
  schema, migrates older databases, seeds the first launch (an unnamed owner, an Architect
  and a Coder, the example board). Override the path with `CS_DB_PATH`.
- `src/server/store.ts` — all reads and writes plus the rules above: mention → run, column
  → run, Ready → dispatch, the queue with its blockers, the agent-chain guard, one run at a
  time per agent and one coder run at a time per repository.
- `src/app/api/*` — thin HTTP layer over the store. `GET /api/events` streams change
  notifications; the UI and the worker refetch on each. `GET /api/agents` lists the agents
  with their configuration; `POST /api/boards/:id/dispatch` applies the Architect's decision.
- `agents/worker.mjs` — reads the agents from the board, polls `/api/agents/claim` for each,
  runs the agent through its engine's adapter, posts the reply as the agent and applies the
  `ACTIONS: {...}` line from the reply (`move`, or `assign` / `order` / `blocked_by` for a
  dispatch). Heartbeats to `/api/agents/heartbeat` every 5 s with the CLIs it found; polls a
  running run for the Stop flag; runs the board's check command before a coder's hand-off. Adapters: `stub` (no model), `claude` (`claude -p`; the Architect gets read-only
  tools, coders can edit and run git/npm/node), `codex` (`codex exec`, workspace-write for
  coders, read-only for the Architect). The role prompts live in `agents/prompts/` — edit
  them to change how the agents behave; `dispatch.md` is what the Architect gets for the queue.

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `43123` | port of the board (`npm run up`) |
| `CS_DB_PATH` | `data/board.db` | SQLite file |
| `CS_API` | `http://localhost:43123` | board URL for the worker |
| `CS_AGENT_MODE` | `live` with `npm run up`, `stub` for `npm run worker` | `stub` (every agent runs without a model) or `live` |
| `CS_CLAUDE_BIN` / `CS_CODEX_BIN` | `claude` / `codex` | CLI binaries |
| `CS_CLAUDE_MODEL` / `CS_CODEX_MODEL` | — | model for agents that set none |
| `CS_CLAUDE_MAX_TURNS` | 20 (Architect) / 80 (coders) | turn limit for agents that set none |
| `CS_RUN_TIMEOUT_MS` | 20 min | kill a run after this |
| `CS_CHECK_TIMEOUT_MS` | 10 min | kill a board's check command after this |
| `CS_NO_OPEN` | — | set to skip opening the browser |

Pieces separately: `npm run dev` (board only), `npm run worker` (stub agents),
`npm run worker:live` (real agents).

## Stack

Next.js 16 (App Router, Turbopack) · React 19 · TypeScript · Tailwind CSS 4 · dnd-kit ·
`node:sqlite`. The UI follows the *Creative Wizards* tracker design from Figma.

## License

MIT — see [LICENSE](LICENSE).
