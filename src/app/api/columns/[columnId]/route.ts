import { handle, json, readJson } from "@/server/http"
import { deleteColumn, updateColumn } from "@/server/store"

export const dynamic = "force-dynamic"

type Ctx = { params: Promise<{ columnId: string }> }

export const PATCH = handle(async (request: Request, ctx: Ctx) => {
  const { columnId } = await ctx.params
  const body = await readJson(request)
  return json(updateColumn(columnId, { title: body.title, role: body.role, position: body.position }))
})

export const DELETE = handle(async (_request: Request, ctx: Ctx) => {
  const { columnId } = await ctx.params
  deleteColumn(columnId)
  return json({ ok: true })
})
