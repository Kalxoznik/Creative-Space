import { handle, json, readJson } from "@/server/http"
import { createColumn } from "@/server/store"

export const dynamic = "force-dynamic"

type Ctx = { params: Promise<{ boardId: string }> }

export const POST = handle(async (request: Request, ctx: Ctx) => {
  const { boardId } = await ctx.params
  const body = await readJson(request)
  return json(createColumn(boardId, { title: body.title, role: body.role }), { status: 201 })
})
