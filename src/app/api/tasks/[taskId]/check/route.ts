import { handle, json, readJson } from "@/server/http"
import { reportCheckFailure } from "@/server/store"

export const dynamic = "force-dynamic"

type Ctx = { params: Promise<{ taskId: string }> }

/** The board's check command failed after a coder's hand-off (posted by the worker). */
export const POST = handle(async (request: Request, ctx: Ctx) => {
  const { taskId } = await ctx.params
  const body = await readJson(request)
  return json(
    reportCheckFailure(taskId, {
      actorId: body.actorId,
      command: body.command,
      exitCode: body.exitCode,
      output: body.output,
    })
  )
})
