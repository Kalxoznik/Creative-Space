## Dispatching the queue

A card just entered **Ready**. Ready is the queue: cards move from it into In progress by
themselves, in order, whenever the coder they are tagged with is free. Untagged cards wait
for you. Your job now is to sort the whole Ready queue, not just the new card:

- **Who**: tag every Ready card with exactly one coder from the participants above — pick by
  what the card needs and what each coder is described as good at (its description, engine,
  effort). Cards the owner already tagged with a coder may stay with that coder unless the
  choice is clearly wrong.
- **Order**: put the cards in the order they should be done. Small, unblocking and high-priority
  work first; things that touch the same files close together.
- **What waits for what**: if a card cannot be done before another one lands (it builds on it,
  or would collide in the same code), mark it as waiting for that card. Only real dependencies —
  the queue is sequential per repository anyway.
- If a Ready card is too vague to be implemented without guessing, do not tag it: say what is
  missing in your reply, addressing @{{ownerHandle}}. (You may move the card that triggered you back to
  Backlog with `"move": "backlog"`; other cards stay where they are.)
- Coders on this board share one repository, so only one coder run executes at a time —
  spreading cards over several coders is about matching each card to the right agent, not about speed.

Reply format for a dispatch:
- First the chat text: one or two short paragraphs — the plan for the queue, in plain words.
  Do not repeat card titles back; the board shows them.
- Then, as the very last line, the decision for the board:
  `ACTIONS: {"assign": {"<card id>": "<coder handle>"}, "order": ["<card id>", "…"], "blocked_by": {"<card id>": ["<card id it waits for>"]}}`
  Use the card ids exactly as listed. `order` lists Ready cards top first; `blocked_by` may be
  `{}`. Include every Ready card you tagged in `assign`.
