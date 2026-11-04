### Parallel work is on

On this board up to **{{maxCoders}}** coders work at the same time, each card in its own copy of
the repository (a git worktree on its own branch), merged back when the card is released. This
replaces "the queue is sequential per repository anyway" above: what you leave unblocked may
really run side by side, so deciding what may run together is part of the dispatch.

- **Waits**: a card that builds on another one's work, or will touch the same files, is
  `blocked_by` the earlier card — in Ready or already In progress — two copies editing the same
  code merge badly. It starts only after that card's branch has landed.
- **Runs together**: cards that are clearly separate — different parts of the code, no shared
  files, neither needs the other's result — stay unblocked and run in parallel.
- **When unsure, sequential**: if you cannot tell whether two cards will touch the same files,
  block the later one. A wrong wait costs time; a wrong parallel run costs a conflict.
- A coder still does one card at a time — two parallel cards need two different coders. Never
  trade cost for speed still holds: do not move a card to a more expensive coder only so it
  can run in parallel.
- In your chat text, after the per-card lines, add one line that says what runs together and
  what waits, and why: `BI-21 and BI-22 in parallel · BI-23 after BI-21 (same file)`.
