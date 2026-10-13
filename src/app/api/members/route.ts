import { handle, json, readJson } from "@/server/http"
import { createPerson, listMembers } from "@/server/store"

export const dynamic = "force-dynamic"

/** Everyone in the workspace — people and agents. */
export const GET = handle(async () => json({ members: listMembers() }))

/**
 * Add a person who takes part over the API (there is no UI for it: a workspace has one owner).
 * Put them on a board afterwards with `memberIds` in PATCH /api/boards/:id — see docs/people.md.
 */
export const POST = handle(async (request: Request) => {
  const body = await readJson(request)
  return json(createPerson({ name: body.name, handle: body.handle, tone: body.tone }), { status: 201 })
})
