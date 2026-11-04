# One architect per board

Status: done
Updated: 2026-11-04

## Goal

Each board chooses its own architect. Two boards with different architects can dispatch,
review and supervise concurrently, while each agent still runs only one job at a time.

## How it is built

- `boards.architect_id` references the chosen member. The schema migration preserves the
  first active architect in each existing board's member order, falling back to the first
  active workspace architect if necessary. New boards default to the first active architect.
  With none available, the ID is null and architect-enabled is false. Existing disabled
  boards stay disabled. Reopening a database never adds unrelated architects to boards.
- `Board.architectId`, board summaries and create/update routes expose the selection.
  `boardArchitect` in `src/server/store.ts` supplies the enabled architect for dispatch,
  review, supervision, escalation, default task participants, owner messages and queue
  release. Only that architect can apply dispatch, escalation, reassignment or approval.
- Only the owner is pinned globally. The chosen architect is automatically a board member
  even when switched off; other architects may be selected as ordinary members and answer
  mentions. Their follow-up cards go to Backlog without chaining; only the selected architect
  may create Ready cards or chain follow-ups. The Architect-off switch suppresses architect runs.
- Board details and New board share an Architect select. Only the selected architect's
  membership checkbox is locked. The Agents page lists the boards each architect runs,
  marking disabled and archived boards. Run context and prompts name the selected architect;
  another architect answering a mention is told it is consulting on this board.
- Changing the selection transfers queued dispatch, review, escalation, supervision and
  untagged-owner runs. Explicit mentions stay addressed to their recipient. Wait for a
  running architect job on that board to finish before changing the selection.
- Deleting the selected architect, or changing its role to coder, chooses the first other
  active architect and transfers queued duties. With no replacement, the existing
  architect-off rules release finished reviews and flag unresolved escalation/supervision
  for the owner. Non-archived Ready and In progress cards, plus any card whose queued run is
  transferred or cancelled, get a system message naming the replacement (or none).
- Tests: `tests/store-board-architect.test.mjs`, `tests/db-migrate.test.mjs` and
  `agents/lib.test.mjs`. All use temporary databases or prompt fixtures, with no model calls.
- Decision: `docs/decisions.md`, 2026-11-04 — explicit board architect selection.

## Subtasks

- [x] BI-131: migrate selection, implement routing and membership, add selectors and agent
  board labels, preserve pending duties on replacement, and verify independent architect runs.
- [x] Review fixes: limit replacement messages to active/affected cards and reserve Ready
  creation and chaining for the selected architect, with regression coverage.

## Open questions

None.
