import { handle, json } from "@/server/http"
import { listArchived } from "@/server/store"

export const dynamic = "force-dynamic"

type Ctx = { params: Promise<{ boardId: string }> }

export const GET = handle(async (_request: Request, ctx: Ctx) => {
  const { boardId } = await ctx.params
  return json({ tasks: listArchived(boardId) })
})
