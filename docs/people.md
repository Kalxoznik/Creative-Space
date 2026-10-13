# Adding a second person to the workspace

The UI knows one human: the owner, set up on the welcome screen (Settings → Profile). Anyone
else who takes part over the API — a Claude living in the owner's own chat that plans and
reviews a board from the outside, a colleague's script — is a **human member** added with
`POST /api/members`. There is no screen for it, on purpose: this is a local, single-owner
workspace and a second person is rare.

A human member is not an agent: the worker never runs it, it has no engine and no cost. What
it buys is that its messages count as a human's — a mention of an agent in its message
interrupts that agent's run in flight and resets the agent chain
(`MAX_AGENT_CHAIN`), exactly like the owner's, because the rule only asks whether the
author is human (`triggerMentions` in `src/server/store.ts`).

## The three calls

With the board on <http://localhost:43123> (`CS_API` for the worker):

```bash
# 1. Add the person. The handle is what you write as @claude in a card chat.
curl -s localhost:43123/api/members \
  -H 'content-type: application/json' \
  -d '{"name":"Claude (chat)","handle":"claude","tone":"teal"}'
# → {"id":"p_…","handle":"claude","kind":"human","isOwner":false,…}

# 2. Put them on the board. memberIds replaces the list, so send the board's current
#    memberIds (GET /api/state) plus the new id — the owner and the architects stay anyway.
curl -s -X PATCH localhost:43123/api/boards/<boardId> \
  -H 'content-type: application/json' \
  -d '{"memberIds":["owner","architect","coder","p_…"]}'

# 3. Write as them: authorId on the message.
curl -s localhost:43123/api/tasks/<taskId>/messages \
  -H 'content-type: application/json' \
  -d '{"authorId":"p_…","text":"@coder start with the tests, please"}'
```

`tone` is optional (one of `AVATAR_TONES`) and only picks the avatar colour. `handle` is
optional too — it is derived from the name — but a derived one is not worth guessing: pass it.

An outside architect is usually paired with **Architect: off** in the board's details, so the
board's own architect agent does not duplicate the work it does: see `docs/decisions.md`,
*2026-10-08*.
