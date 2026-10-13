import { handle, json, readJson } from "@/server/http"
import { createAgent, listAgents } from "@/server/store"

export const dynamic = "force-dynamic"

/** The live agents with their configuration — the worker reads this to know whom to run. */
export const GET = handle(async () => json({ agents: listAgents() }))

export const POST = handle(async (request: Request) => {
  const body = await readJson(request)
  return json(createAgent(body), { status: 201 })
})
