import { handle, json, readJson } from "@/server/http"
import { deleteTask, getThread, updateTask } from "@/server/store"

export const dynamic = "force-dynamic"

type Ctx = { params: Promise<{ taskId: string }> }

export const GET = handle(async (_request: Request, ctx: Ctx) => {
  const { taskId } = await ctx.params
  return json(getThread(taskId))
})

export const PATCH = handle(async (request: Request, ctx: Ctx) => {
  const { taskId } = await ctx.params
  const body = await readJson(request)
  return json(
    updateTask(taskId, {
      title: body.title,
      description: body.description,
      priority: body.priority,
      assigneeIds: body.assigneeIds,
      columnId: body.columnId,
      columnRole: body.columnRole,
      position: body.position,
      archived: body.archived,
    })
  )
})

export const DELETE = handle(async (_request: Request, ctx: Ctx) => {
  const { taskId } = await ctx.params
  deleteTask(taskId)
  return json({ ok: true })
})
