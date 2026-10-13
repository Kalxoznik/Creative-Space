import { handle, json, readJson } from "@/server/http"
import { appendRunLog, finishRun, getRun } from "@/server/store"

export const dynamic = "force-dynamic"

type Ctx = { params: Promise<{ runId: string }> }

export const GET = handle(async (_request: Request, ctx: Ctx) => {
  const { runId } = await ctx.params
  return json(getRun(Number(runId)))
})

/**
 * Worker progress: { appendLog } while running, { status, summary, plain } to finish —
 * plus { turnLimit: true } when the run ran out of turns and left work in the checkout.
 */
export const PATCH = handle(async (request: Request, ctx: Ctx) => {
  const { runId } = await ctx.params
  const id = Number(runId)
  const body = await readJson(request)
  let run = getRun(id)
  if (typeof body.appendLog === "string" && body.appendLog) {
    run = appendRunLog(id, body.appendLog)
  }
  if (typeof body.status === "string") {
    run = finishRun(id, {
      status: body.status,
      summary: body.summary,
      plain: body.plain,
      turnLimit: body.turnLimit,
    })
  }
  return json(run)
})
