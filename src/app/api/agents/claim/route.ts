import { handle, json, readJson } from "@/server/http"
import { claimRun } from "@/server/store"

export const dynamic = "force-dynamic"

/** The worker asks for work: returns a RunContext or { run: null }. */
export const POST = handle(async (request: Request) => {
  const body = await readJson(request)
  const agentId = typeof body.agentId === "string" ? body.agentId : ""
  const context = claimRun(agentId)
  return json(context ?? { run: null })
})
