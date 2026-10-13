import { handle, json, readJson } from "@/server/http"
import { addMessage, listMessages, listReactions } from "@/server/store"

export const dynamic = "force-dynamic"

type Ctx = { params: Promise<{ taskId: string }> }

export const GET = handle(async (_request: Request, ctx: Ctx) => {
  const { taskId } = await ctx.params
  // The reactions come with the messages they are on — a client that reads the chat reads both.
  return json({ messages: listMessages(taskId), reactions: listReactions(taskId) })
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
    source: body.source,
    // The bot passes the owner's own Telegram message, so the answer can go back as a reply to
    // it (agents/telegram.mjs → agents/notify.mjs).
    telegramMessageId: body.telegramMessageId,
  })
  return json(message, { status: 201 })
})
