import { handle, json, readJson } from "@/server/http"
import { reassignTask } from "@/server/store"

export const dynamic = "force-dynamic"

type Ctx = { params: Promise<{ taskId: string }> }

/**
 * The Architect's `reassign` action (posted by the worker): a stuck card it was woken on goes to
 * another coder on the board. Whether that is allowed is the store's call.
 */
export const POST = handle(async (request: Request, ctx: Ctx) => {
  const { taskId } = await ctx.params
  const body = await readJson(request)
  return json(reassignTask(taskId, { actorId: body.actorId, to: body.to, reason: body.reason }))
})
