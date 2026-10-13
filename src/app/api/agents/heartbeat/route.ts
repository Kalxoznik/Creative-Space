import { handle, json, readJson } from "@/server/http"
import { reportHeartbeat } from "@/server/worker-status"

export const dynamic = "force-dynamic"

/** The worker says it is alive: its mode and which CLIs it found. */
export const POST = handle(async (request: Request) => {
  const body = await readJson(request)
  return json(reportHeartbeat({ mode: body.mode, engines: body.engines }))
})
