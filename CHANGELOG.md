# Changelog

## 0.1.0 — 2026-10-13

The first public release.

- **A local kanban board** — Backlog, Ready, In progress, Review, Done; drag and drop, renamable
  columns, several boards, all stored in one SQLite file on your machine. No accounts, no cloud.
- **Agents on the CLIs you already have** — each agent runs on Claude Code or the Codex CLI with
  its own model, effort level, turn limit and extra instructions. No API keys: runs spend quota on
  your own subscription.
- **An Architect and any number of coders** — the Architect plans, dispatches and reviews and is
  read-only by construction; coders implement cards in your repository, one coder run at a time
  per repository.
- **Dispatch by the Architect** — a card entering Ready is assigned to the coder that fits it, put
  in order and chained after the cards it depends on. *Architect: off* runs a board without one.
- **One card at a time** — on by default: the next Ready card starts after the current one is Done.
- **Check before Review, commit by the board** — a board's check command runs when a coder hands a
  card off; only when it passes does the board commit the paths that run changed. Agents never
  commit, push or rewrite history.
- **Card chat with @mentions and images** — `@handle` wakes that agent; pasted images reach the
  agents as files; a guard pauses agent-to-agent threads until a human writes.
- **Asking the owner** — an agent can stop on a question, a paid call, a write to the corpus or a
  deploy; the card waits with a *Needs owner* badge until you answer.
- **Archive** — Done cards can be archived and restored from the sidebar.
- **Notifications** — macOS notifications and, with a bot token in `.env`, Telegram: a card in
  Review, a card waiting for you, a failed run or check. Replies to the bot land in the card's chat.
- **Stub mode** — `CS_AGENT_MODE=stub` runs the whole loop with canned agents and no model calls.
- **Project docs template** — `templates/project-docs/` gives a project the `AGENTS.md` and `docs/`
  files the agents read before every run.
