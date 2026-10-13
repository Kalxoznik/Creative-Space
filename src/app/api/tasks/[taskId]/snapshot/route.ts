import { handle, json, readJson } from "@/server/http"
import { clearWorkSnapshot, keepWorkSnapshot } from "@/server/store"

export const dynamic = "force-dynamic"

type Ctx = { params: Promise<{ taskId: string }> }

/**
 * The state of the repository when work on this card started (written by the worker at the
 * start of a coder run). POST offers one and gets back the card's — the first offer wins, so
 * a later run commits against the start of the work, not against its own start.
 */
export const POST = handle(async (request: Request, ctx: Ctx) => {
  const { taskId } = await ctx.params
  const body = await readJson(request)
  return json(keepWorkSnapshot(taskId, body.snapshot))
})

/** The work it covered is committed. */
export const DELETE = handle(async (_request: Request, ctx: Ctx) => {
  const { taskId } = await ctx.params
  clearWorkSnapshot(taskId)
  return json({ ok: true })
})
