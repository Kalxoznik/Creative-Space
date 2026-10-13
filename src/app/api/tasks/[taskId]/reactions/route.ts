import { handle, json, readJson } from "@/server/http"
import { addReaction, listReactions, removeReaction } from "@/server/store"

export const dynamic = "force-dynamic"

type Ctx = { params: Promise<{ taskId: string }> }

// Reactions on a card's messages: 👍 and nothing else. What it *means* — the owner's 👍 on a card
// in Review closes it — is store.ts; this route only carries it. `messageId` left out = the
// reaction is on the card itself, which is how a reaction on a Telegram notification with no
// board message behind it arrives (agents/telegram.mjs).

export const GET = handle(async (_request: Request, ctx: Ctx) => {
  const { taskId } = await ctx.params
  return json({ reactions: listReactions(taskId) })
})

export const POST = handle(async (request: Request, ctx: Ctx) => {
  const { taskId } = await ctx.params
  const body = await readJson(request)
  return json(
    addReaction({ taskId, emoji: body.emoji, messageId: body.messageId, memberId: body.memberId }),
    { status: 201 }
  )
})

export const DELETE = handle(async (request: Request, ctx: Ctx) => {
  const { taskId } = await ctx.params
  const body = await readJson(request)
  return json(removeReaction({ taskId, emoji: body.emoji, messageId: body.messageId, memberId: body.memberId }))
})
