import { handle, json } from "@/server/http"
import { cancelRun } from "@/server/store"

export const dynamic = "force-dynamic"

type Ctx = { params: Promise<{ runId: string }> }

/** Stop: a queued run is cancelled at once; a running one is flagged and the worker kills it. */
export const POST = handle(async (_request: Request, ctx: Ctx) => {
  const { runId } = await ctx.params
  return json(cancelRun(Number(runId)))
})
