import { handle, json } from "@/server/http"
import { checkRepo, plannedRepoPath } from "@/server/store"

export const dynamic = "force-dynamic"

/**
 * GET /api/repo-check?path=… — is this a folder the agents can work in?
 * GET /api/repo-check?name=… — which folder a new board with that name would get.
 */
export const GET = handle(async (request: Request) => {
  const url = new URL(request.url)
  const name = url.searchParams.get("name")
  if (name !== null) return json(checkRepo(plannedRepoPath(name)))
  return json(checkRepo(url.searchParams.get("path") ?? ""))
})
