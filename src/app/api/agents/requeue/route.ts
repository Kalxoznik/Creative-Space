import { handle, json, readJson } from "@/server/http"
import { requeueRunningRuns } from "@/server/store"

export const dynamic = "force-dynamic"

/** Worker start-up: anything left 'running' by a previous worker goes back to the queue. */
export const POST = handle(async (request: Request) => {
  const body = await readJson(request)
  const agentId = typeof body.agentId === "string" ? body.agentId : ""
  return json({ requeued: requeueRunningRuns(agentId) })
})
