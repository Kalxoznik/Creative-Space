import { handle, json } from "@/server/http"
import { getTaskDigest } from "@/server/digest"

export const dynamic = "force-dynamic"

type Ctx = { params: Promise<{ taskId: string }> }

/**
 * The card in one short read: state, last run, the check, the commit, the last messages —
 * what an architect reading the board from outside needs instead of the full run logs.
 */
export const GET = handle(async (_request: Request, ctx: Ctx) => {
  const { taskId } = await ctx.params
  return json(getTaskDigest(taskId))
})
