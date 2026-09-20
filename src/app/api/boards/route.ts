import { handle, json, readJson } from "@/server/http"
import { createBoard } from "@/server/store"

export const dynamic = "force-dynamic"

export const POST = handle(async (request: Request) => {
  const body = await readJson(request)
  return json(
    createBoard({
      name: body.name,
      repoPath: body.repoPath,
      memberIds: body.memberIds,
      starterCard: body.starterCard,
    }),
    { status: 201 }
  )
})
