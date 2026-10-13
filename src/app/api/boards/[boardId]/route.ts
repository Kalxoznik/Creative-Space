import { handle, json, readJson } from "@/server/http"
import { deleteBoard, updateBoard } from "@/server/store"

export const dynamic = "force-dynamic"

type Ctx = { params: Promise<{ boardId: string }> }

export const PATCH = handle(async (request: Request, ctx: Ctx) => {
  const { boardId } = await ctx.params
  const body = await readJson(request)
  return json(
    updateBoard(boardId, {
      name: body.name,
      key: body.key,
      repoPath: body.repoPath,
      archived: body.archived,
      memberIds: body.memberIds,
      checkCommand: body.checkCommand,
      architectEnabled: body.architectEnabled,
      notificationsEnabled: body.notificationsEnabled,
      notificationsDetailed: body.notificationsDetailed,
      oneCardAtATime: body.oneCardAtATime,
    })
  )
})

export const DELETE = handle(async (_request: Request, ctx: Ctx) => {
  const { boardId } = await ctx.params
  deleteBoard(boardId)
  return json({ ok: true })
})
