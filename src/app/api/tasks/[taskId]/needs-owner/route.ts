import { handle, json, readJson } from "@/server/http"
import { clearNeedsOwner, setNeedsOwner } from "@/server/store"

export const dynamic = "force-dynamic"

type Ctx = { params: Promise<{ taskId: string }> }

/**
 * An agent stops the card on the owner's word (posted by the worker for
 * `ACTIONS: {"needs": "owner", "reason": …, "text": …}`). The card does not move.
 */
export const POST = handle(async (request: Request, ctx: Ctx) => {
  const { taskId } = await ctx.params
  const body = await readJson(request)
  return json(
    setNeedsOwner(taskId, { actorId: body.actorId, reason: body.reason, text: body.text, plain: body.plain })
  )
})

/** The button on the badge: the card is no longer waiting. */
export const DELETE = handle(async (request: Request, ctx: Ctx) => {
  const { taskId } = await ctx.params
  const body = await readJson(request)
  return json(clearNeedsOwner(taskId, { actorId: body.actorId }))
})
