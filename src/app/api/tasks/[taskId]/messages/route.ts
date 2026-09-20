import { handle, json, readJson } from "@/server/http"
import { addMessage, listMessages } from "@/server/store"

export const dynamic = "force-dynamic"

type Ctx = { params: Promise<{ taskId: string }> }

export const GET = handle(async (_request: Request, ctx: Ctx) => {
  const { taskId } = await ctx.params
  return json({ messages: listMessages(taskId) })
})

export const POST = handle(async (request: Request, ctx: Ctx) => {
  const { taskId } = await ctx.params
  const body = await readJson(request)
  const message = addMessage({
    taskId,
    authorId: body.authorId,
    text: body.text,
    kind: body.kind,
    participant: body.participant,
  })
  return json(message, { status: 201 })
})
