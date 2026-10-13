import { handle, json } from "@/server/http"
import { archiveColumnTasks } from "@/server/store"

export const dynamic = "force-dynamic"

type Ctx = { params: Promise<{ columnId: string }> }

export const POST = handle(async (_request: Request, ctx: Ctx) => {
  const { columnId } = await ctx.params
  return json({ archived: archiveColumnTasks(columnId) })
})
