import { handle, json, readJson } from "@/server/http"
import { createAgentTasks } from "@/server/store"

export const dynamic = "force-dynamic"

type Ctx = { params: Promise<{ taskId: string }> }

/**
 * Follow-up cards an agent asked for at the end of a run (the `create` action, posted by
 * the worker). Backlog by default; the Architect may ask for Ready — see createAgentTasks.
 */
export const POST = handle(async (request: Request, ctx: Ctx) => {
  const { taskId } = await ctx.params
  const body = await readJson(request)
  return json(
    createAgentTasks(taskId, {
      actorId: body.actorId,
      cards: body.cards,
      column: body.column,
      parallel: body.parallel,
    }),
    { status: 201 }
  )
})
