import { handle, json } from "@/server/http"
import { checkRepo } from "@/server/store"

export const dynamic = "force-dynamic"

/** GET /api/repo-check?path=… — is this a folder the agents can work in? */
export const GET = handle(async (request: Request) => {
  const url = new URL(request.url)
  return json(checkRepo(url.searchParams.get("path") ?? ""))
})
