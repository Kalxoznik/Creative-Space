import { handle, json, readJson } from "@/server/http"
import { recordWorktree } from "@/server/store"

export const dynamic = "force-dynamic"

type Ctx = { params: Promise<{ taskId: string }> }

/** The card's own worktree (Parallel work), written by the worker once it has made it. */
export const POST = handle(async (request: Request, ctx: Ctx) => {
  const { taskId } = await ctx.params
  const body = await readJson(request)
  return json(recordWorktree(taskId, { branch: body.branch, path: body.path, base: body.base }))
})
