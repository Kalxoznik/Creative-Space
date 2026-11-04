import { handle, json, readJson } from "@/server/http"
import { escalateTask } from "@/server/store"

export const dynamic = "force-dynamic"

type Ctx = { params: Promise<{ taskId: string }> }

/**
 * The Architect's `escalate` action (posted by the worker): the card whose check failed after
 * its retry goes to a coder one tier up. Whether that is allowed is the store's call.
 */
export const POST = handle(async (request: Request, ctx: Ctx) => {
  const { taskId } = await ctx.params
  const body = await readJson(request)
  return json(escalateTask(taskId, { actorId: body.actorId, to: body.to, reason: body.reason }))
})
