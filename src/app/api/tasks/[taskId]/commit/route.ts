import { handle, json, readJson } from "@/server/http"
import { reportCommit } from "@/server/store"

export const dynamic = "force-dynamic"

type Ctx = { params: Promise<{ taskId: string }> }

/**
 * What the board's commit step did for this card (posted by the worker, which is the only side
 * that knows the sha and the paths): `{ sha, files }`, or `{ skipped: "<why>" }`. Feed only.
 */
export const POST = handle(async (request: Request, ctx: Ctx) => {
  const { taskId } = await ctx.params
  const body = await readJson(request)
  return json(
    reportCommit(taskId, {
      actorId: body.actorId,
      sha: body.sha,
      files: body.files,
      skipped: body.skipped,
    })
  )
})
