# Creative Space

A kanban board where you and two coding agents work on a project together. **Architect**
plans tasks and reviews the work; **Coder** implements them in your repository and commits.
You talk to them in each card's chat, drag cards between columns, and the board shows who
is doing what. Everything runs on your own computer and is stored in one SQLite file — no
accounts, no cloud, no keys to paste. The agents run on the Claude Code (or Codex) CLI you
already have installed, on your own subscription.

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

The first launch asks for your name — that's the whole setup. Then create your first
board: give it a name, point it at the project folder, choose which agents take part and
which CLI runs each one. If the folder has no `CLAUDE.md` yet, the dialog offers to add a
first card where the Coder reads the project and writes one, so both agents know the
stack, the structure and how to run and check things on every run after that.

Every agent run spends quota on the plan behind your CLI. To try the loop without any
model calls: `CS_AGENT_MODE=stub npm run up`.

## How work flows

```
Backlog  →  Ready  →  In progress  →  Review  →  Done
 ideas      queue      the Coder      Architect   you
```

- **Ready is the Coder's queue.** Whenever the Coder is free — nothing running, none of its
  cards in In progress — the top Ready card it can work on moves to In progress by itself
  and its run starts. Keep cards in Backlog until you want them done.
- **Drag a card into In progress** to start it right now: the agents tagged on the card
  wake up (an untagged card goes to the Coder; a card tagged with people only wakes nobody).
- **When the Coder is done** it moves the card to Review and takes the next Ready card.
  If it stopped to ask a question, the card stays in In progress and the queue waits for you.
- **Review** wakes the Architect, who reads the actual `git diff` and gives a verdict.
  Moving to Done is yours.
- **@architect** or **@coder** in any card's chat wakes that agent. Agents can talk to each
  other, but after six agent messages in a row the thread pauses until a human writes.
- Columns are recognised by their names (Backlog, Ready / To do, In progress, Review,
  Done) and can be renamed or reordered; a board without a Ready list starts nothing by
  itself, but after a hand-off the Coder continues with the next Backlog card.

Per board you choose which agents take part and which CLI runs each of them (Board
details in the board's menu). Done cards can be archived from the list menu and restored
from *Archived* in the header. Images pasted into a chat or a description are saved to
`uploads/` and passed to the agents as file paths.

## How it works

```
browser ── /api/* ──▶ Next.js route handlers ──▶ src/server/store.ts ──▶ data/board.db (SQLite)
   ▲                                                    │
   └──────────── /api/events (SSE) ◀────────────────────┘
                                                        ▲
agents/worker.mjs ── claim / log / reply / move ────────┘
```

- `src/server/db.ts` — opens `data/board.db` (`node:sqlite`, no native deps), creates the
  schema, migrates older databases, seeds the first launch (an unnamed owner and the two
  agents). Override the path with `CS_DB_PATH`.
- `src/server/store.ts` — all reads and writes plus the rules above: mention → run, column
  → run, the Ready queue, the agent-chain guard, one run at a time per agent.
- `src/app/api/*` — thin HTTP layer over the store. `GET /api/events` streams change
  notifications; the UI and the worker refetch on each.
- `agents/worker.mjs` — polls `/api/agents/claim`, runs the agent through an adapter,
  posts the reply as the agent, applies `ACTIONS: {"move": "..."}` from the reply.
  Adapters: `stub` (no model), `claude` (`claude -p`; the Architect gets read-only tools,
  the Coder can edit and run git/npm/node), `codex` (`codex exec --full-auto`). The role
  prompts live in `agents/prompts/` — edit them to change how the agents behave.

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `43123` | port of the board (`npm run up`) |
| `CS_DB_PATH` | `data/board.db` | SQLite file |
| `CS_API` | `http://localhost:43123` | board URL for the worker |
| `CS_AGENT_MODE` | `live` with `npm run up`, `stub` for `npm run worker` | `stub` or `live` |
| `CS_ARCHITECT` / `CS_CODER` | `claude` / `claude` | default engine per role (`stub`, `claude`, `codex`); a board can override it |
| `CS_CLAUDE_BIN` / `CS_CODEX_BIN` | `claude` / `codex` | CLI binaries |
| `CS_CLAUDE_MODEL` / `CS_CODEX_MODEL` | — | model override |
| `CS_CLAUDE_MAX_TURNS` | 20 (Architect) / 80 (Coder) | turn limit per run |
| `CS_RUN_TIMEOUT_MS` | 20 min | kill a run after this |
| `CS_NO_OPEN` | — | set to skip opening the browser |

Pieces separately: `npm run dev` (board only), `npm run worker` (stub agents),
`npm run worker:live` (real agents).

## Stack

Next.js 16 (App Router, Turbopack) · React 19 · TypeScript · Tailwind CSS 4 · dnd-kit ·
`node:sqlite`. The UI follows the *Creative Wizards* tracker design from Figma.

## License

MIT — see [LICENSE](LICENSE).
