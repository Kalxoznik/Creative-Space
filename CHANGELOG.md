# Changelog

## Unreleased

- **Up to six coders at once** — *Max coders at once* (Board details) goes to 6, not 3. Existing
  boards keep their value. New: a machine-wide cap, `CS_MAX_CODERS` (default 6), on coder runs
  across all boards, so several boards at their maximum cannot start dozens of processes.

## 0.2.0 — 2026-11-04

- **Mac app** — Creative Space ships as a normal macOS app (unsigned arm64 DMG). The board and the
  agent worker run hidden inside it: no terminal, no localhost to open, no Node to install. Data
  lives in `~/Library/Application Support/creative-space`. Git is bundled, so a Mac without the
  developer tools works too. Claude Code and Codex are found in the usual install places.
- **Update check** — the app looks for a newer GitHub Release and offers the download
  (Help → Check for updates…).
- **Parallel work** — optional per board: each card gets its own git worktree and branch, up to
  *Max coders at once* coders run at the same time, the Architect decides what runs in parallel
  and what waits, a merge conflict goes back to the card's coder, stale worktrees are swept.
- **Cost-aware routing** — coders have a tier (Fast / Standard / Strong) with a model and an
  effort; the Architect sizes every card S / M / L and gives it to the cheapest tier that can do it,
  with the reason in the chat. A card that fails the check after its retry goes one tier up, once.
- **The Architect supervises** — a failed run, a timeout, a stopped loop or a failed check wakes
  the Architect, who hints and retries, reassigns or splits the card, or asks the owner; at most two
  interventions per card. *Autopilot* (off by default) lets it move approved cards to Done.
- **Loop detection** — the same call, the same failing command or long stretches without progress
  stop a run with a plain message; agent ping-pong on a card pauses it for the owner. The low turn
  limit is gone.
- **One Architect per board**, **next card after the Architect's approval**, a scrollable
  New board dialog with collapsible sections, and many smaller fixes.
- **Telegram** is off in the Mac app until you enter your own bot in Workspace settings.

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
