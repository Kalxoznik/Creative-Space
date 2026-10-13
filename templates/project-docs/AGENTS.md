# <Project name>

<One or two sentences: what this project is and who it is for.>

## Stack

- Language / runtime: <…>
- Framework: <…>
- Database / storage: <…>
- Anything unusual an agent would guess wrong: <…>

## Layout

| Path | What lives there |
| --- | --- |
| `src/` | <…> |
| `docs/` | project context — see below |
| `<…>` | <…> |

## How to run and check

```bash
<install>        # e.g. npm install
<dev>            # e.g. npm run dev
<typecheck>      # e.g. npm run typecheck
<lint>           # e.g. npm run lint
<test>           # e.g. npm test
```

Before handing a card to Review, run <typecheck> and <lint>; they must be green.

## Project context lives in files, not in chats

- `docs/status.md` — what works, what is broken, what is next. Update it when the state
  of the project changes.
- `docs/decisions.md` — the decision log: date, decision, why, what was rejected.
  Append an entry whenever a real choice is made, don't re-litigate it in a chat.
- `docs/features/<slug>.md` — one file per feature: the goal, how it is built, the
  subtasks as checkboxes, open questions. A card that belongs to a feature names its
  file and its item; read the file before you write code and tick the item in the same
  change.

## Conventions

- <naming, formatting, commit style, error handling — whatever an agent must not invent>
- Never touch: <paths that are off limits, e.g. generated files, local data>
