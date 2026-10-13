# Creative Space

A local kanban board where the owner, an Architect agent and one or more Coder agents work on
a project together. Everything runs on one machine against a single SQLite file; the agents
are the Claude Code / Codex CLI the user already has installed. See `README.md` for the
product-level tour — this file is the working agreement for whoever (human or agent) changes
the code.

## Stack

- Language / runtime: TypeScript, Node ≥ 22.13 (24 recommended) — the board uses Node's
  built-in `node:sqlite`.
- Framework: Next.js 16 (App Router, Turbopack) · React 19 · Tailwind CSS 4 · shadcn/Base UI
  components · dnd-kit for drag and drop.
- Database / storage: `data/board.db`, opened and migrated in `src/server/db.ts`. No ORM, no
  native dependencies, no migration tool — the schema and its migrations are plain SQL there.
- The agent side is plain ESM JavaScript (`.mjs`) under `agents/`, run by Node directly — it is
  not part of the Next build and is not type-checked.

## Layout

| Path | What lives there |
| --- | --- |
| `src/app/` | App Router pages and `api/*` route handlers — a thin HTTP layer over the store |
| `src/components/` | `kanban-app.tsx` (the whole board UI) and `ui/` primitives |
| `src/lib/` | shared client/server helpers and types (`types.ts`, `api.ts`, `task-ref.ts`) |
| `src/server/` | `store.ts` (all reads, writes and rules), `db.ts`, `events.ts` (SSE), uploads |
| `agents/` | `worker.mjs` (the run loop), `git.mjs` (the commit step), `lib.mjs` (ACTIONS parsing), `notify.mjs` / `telegram.mjs` (the owner's notifications and the replies to them), `adapters/` (stub / claude / codex), `*.test.mjs` |
| `agents/prompts/` | the role prompts: `architect.md`, `coder.md`, `dispatch.md` — edit these to change agent behaviour |
| `tests/` | tests for `src/` — `*.test.mjs` plus the resolve hook that lets plain Node import the TypeScript |
| `templates/project-docs/` | what a user copies into *their* project: `AGENTS.md` + `docs/` |
| `docs/` | project context for this repository — see below |
| `scripts/up.mjs` | `npm run up`: board + worker together |
| `data/`, `uploads/` | local board database and pasted images — git-ignored, never touch |

## How to run and check

```bash
npm install
npm run up         # board + worker (live agents), http://localhost:43123
npm run dev        # board only
npm run worker     # worker only, stub agents (no model calls)
npm run typecheck  # tsc --noEmit
npm run lint       # eslint
npm test           # node --test agents/*.test.mjs tests/*.test.mjs
```

Before handing a card to Review, run `npm run typecheck` and `npm run lint`; they must be
green. Touching anything under `agents/` or `src/server/store.ts` — run `npm test` too.

## Project context lives in files, not in chats

- `docs/status.md` — what works, what is broken, what is next. Update it when the state of
  the project changes.
- `docs/decisions.md` — the decision log: date, decision, why, what was rejected. Append an
  entry whenever a real choice is made, don't re-litigate it in a chat.
- `docs/features/<slug>.md` — one file per feature: the goal, how it is built, the subtasks as
  checkboxes, open questions. A card that belongs to a feature names its file and its item;
  read the file before you write code and tick the item in the same change.

This is the same arrangement the board asks of every project it works on — `README.md`,
*How to run a big feature*.

## What an agent will guess wrong

- **Next.js 16 and React 19.** Route handler params are async; check
  `node_modules/next/dist/docs/` instead of recalling an older API.
- **SQLite is `node:sqlite`**, synchronous, no `better-sqlite3`, no Prisma. Schema changes
  mean a migration step in `src/server/db.ts` that also upgrades existing local databases —
  people's boards are live data.
- **`src/server/store.ts` is where the product lives**, not the route handlers: mention → run,
  column → run, Ready → dispatch, the queue and its blockers, one run at a time per agent and
  one coder run at a time per repository. Change behaviour there; routes stay thin.
- **The port is 43123** everywhere (board, `CS_API`, `npm run up`), not 3000.
- **Agents are CLI processes**, not API calls: no keys, no SDK. Engines are selected per agent
  card and spawned in `agents/adapters/`. `CS_AGENT_MODE=stub` runs the whole loop with no
  model.
- **An Architect is read-only by construction** (read-only tools / sandbox). If a task needs
  code written, it belongs to a coder.
- **Agents never commit here either** — the worker commits after the board's check passes.
  Leave your changes in the working tree.
- **`CLAUDE.md` is one line** (`@AGENTS.md`); this file is the real one.
- **The worker picks up agent and board changes without a restart**, but it does not reload
  its own code — edits to `agents/*.mjs` need the worker restarted (the owner does that).
- Tests are `agents/*.test.mjs` and `tests/*.test.mjs`; of `src/` only the store's run queue and
  its architect switch are covered, so for the UI and the routes typecheck and lint are the
  whole gate. A test under
  `tests/` imports `src/*.ts` directly — Node strips the types, and `tests/ts-imports.mjs`
  (wired into `npm test`) resolves the `@/*` alias and extensionless imports for it.

## Conventions

- TypeScript in `src/`, ESM `.mjs` in `agents/`. No semicolons, double quotes, 2-space indent —
  match the file you are in; `npm run lint` is the arbiter.
- Comments explain *why*, at the top of a module or above a non-obvious rule — see
  `agents/git.mjs`. Don't narrate what the code already says.
- UI copy is English; card chats answer in the language of the message that triggered the run.
- Never touch: `data/` (the board's own database), `uploads/`, `export/`, `.next/`.
- Never start or stop the dev server, never push to a remote, never rewrite git history.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
