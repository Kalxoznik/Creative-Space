import { handle, json, readJson } from "@/server/http"
import { updateMe } from "@/server/store"

export const dynamic = "force-dynamic"

/** The owner's profile — the only account there is; nothing here needs a login. */
export const PATCH = handle(async (request: Request) => {
  const body = await readJson(request)
  return json(updateMe({ name: body.name, handle: body.handle }))
})
