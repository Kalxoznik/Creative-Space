# Creative Space

A kanban board where three participants work on one project: **Max** (owner),
**Architect** (Claude Code — plans and reviews) and **Coder** (Claude Code or Codex CLI — implements).
They talk in each task's chat, the board shows who is doing what, and every step is
stored locally in SQLite. Runs entirely on one Mac.

Design: the **Creative Wizards** tracker from Figma — sidebar, top bar, kanban columns,
task detail panel with chat, create/edit task modal.

## Run

Everything at once — double-click **Creative Space.command** in Finder, or:

```bash
npm install            # first time only
npm run up             # board + live agents, opens http://localhost:43123
```

One Ctrl+C stops both. `CS_AGENT_MODE=stub npm run up` runs the agents as stubs.

Pieces separately:

```bash
npm run dev            # board on http://localhost:43123
npm run worker         # agents in stub mode (no model calls) — second terminal
```

Live agents (spend quota on your Claude plan; needs `claude` installed and logged in —
add `CS_CODER=codex` to run the Coder on Codex CLI instead):

```bash
npm run worker:live
```

## How it works

```
browser ── /api/* ──▶ Next.js route handlers ──▶ src/server/store.ts ──▶ data/board.db (SQLite)
   ▲                                                    │
   └──────────── /api/events (SSE) ◀────────────────────┘
                                                        ▲
agents/worker.mjs ── claim / log / reply / move ────────┘
```

- `src/server/db.ts` — opens `data/board.db` (`node:sqlite`, no native deps), creates the
  schema, seeds the first launch. Override the path with `CS_DB_PATH`.
- `src/server/store.ts` — all reads/writes plus the rules that make the board an agent tool:
  - `@architect` / `@coder` in a task chat → a run is queued for that agent;
  - task moved to **In progress** → a run for the agents tagged on the card (none tagged →
    the Coder); moved to **Review** → Architect run;
  - **Ready** is the Coder's queue: whenever the Coder is free (nothing running, none of
    its cards in In progress) the top Ready card it can work on moves to In progress by
    itself and its run starts — keep cards in Backlog until you want them done; on a board
    without a Ready list nothing starts by itself, but after handing a card off the Coder
    continues with the next Backlog card;
  - agents can mention each other, but after 6 agent messages in a row the thread pauses
    until a human writes;
  - one run at a time per agent.
- `src/app/api/*` — thin HTTP layer over the store. `GET /api/events` streams change
  notifications; the UI and the worker refetch on each.
- `agents/worker.mjs` — polls `/api/agents/claim`, executes the run with an adapter,
  posts the reply as the agent, applies `ACTIONS: {"move": "..."}` from the reply.
  Adapters: `stub` (no model), `claude` (`claude -p`, read-only tools), `codex`
  (`codex exec --full-auto`). Prompts live in `agents/prompts/`.

Columns have a semantic `role` (`backlog`, `ready`, `in_progress`, `review`, `done`,
`other`) — the worker reacts to roles, not titles, so columns can be renamed freely.

## Boards

The seed creates the **Creative Space** board (this project's own tracker, members
Max / Architect / Coder) and the two demo boards from the Figma layout. New boards get
the five work columns and the three participants.

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `CS_DB_PATH` | `data/board.db` | SQLite file |
| `CS_API` | `http://localhost:43123` | board URL for the worker |
| `CS_AGENT_MODE` | `stub` | `stub` or `live` |
| `CS_ARCHITECT` / `CS_CODER` | `claude` / `claude` | engine per role in live mode (`stub`, `claude`, `codex`) |
| `CS_CLAUDE_BIN` / `CS_CODEX_BIN` | `claude` / `codex` | CLI binaries |
| `CS_CLAUDE_MODEL` / `CS_CODEX_MODEL` | — | model override |
| `CS_RUN_TIMEOUT_MS` | 20 min | kill a run after this |

## Stack

Next.js 16 (App Router, Turbopack) · React 19 · TypeScript · Tailwind CSS 4 · dnd-kit ·
`node:sqlite` (Node 22.13+ / 24).

## Design tokens

| Token | Value |
| --- | --- |
| Accent | `#E8AB24` |
| Background | `#F6F6F5` |
| Text | `#292826` / `#706E69` / `#A4A19A` |
| Borders | `#E4E2DE` |
