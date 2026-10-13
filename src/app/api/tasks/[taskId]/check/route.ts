import { handle, json, readJson } from "@/server/http"
import { reportCheck } from "@/server/store"

export const dynamic = "force-dynamic"

type Ctx = { params: Promise<{ taskId: string }> }

/**
 * The board's check command ran after a coder's hand-off (posted by the worker): exit 0 goes
 * into the board's event feed, anything else also keeps the card and queues the one retry.
 */
export const POST = handle(async (request: Request, ctx: Ctx) => {
  const { taskId } = await ctx.params
  const body = await readJson(request)
  return json(
    reportCheck(taskId, {
      actorId: body.actorId,
      command: body.command,
      exitCode: body.exitCode,
      output: body.output,
    })
  )
})
