import { handle, json, readJson } from "@/server/http"
import { removeAgent, updateAgent } from "@/server/store"

export const dynamic = "force-dynamic"

type Ctx = { params: Promise<{ agentId: string }> }

export const PATCH = handle(async (request: Request, ctx: Ctx) => {
  const { agentId } = await ctx.params
  const body = await readJson(request)
  return json(updateAgent(agentId, body))
})

/** Removes the agent from every board; its old messages keep their author. */
export const DELETE = handle(async (_request: Request, ctx: Ctx) => {
  const { agentId } = await ctx.params
  removeAgent(agentId)
  return json({ ok: true })
})
