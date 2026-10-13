import { handle, json, readJson } from "@/server/http"
import { applyDispatch } from "@/server/store"

export const dynamic = "force-dynamic"

type Ctx = { params: Promise<{ boardId: string }> }

/** The Architect's dispatch decision for the board's Ready queue (posted by the worker). */
export const POST = handle(async (request: Request, ctx: Ctx) => {
  const { boardId } = await ctx.params
  const body = await readJson(request)
  return json(
    applyDispatch(boardId, {
      actorId: body.actorId,
      assign: body.assign,
      order: body.order,
      blockedBy: body.blockedBy,
    })
  )
})
