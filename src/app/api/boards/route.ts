import { handle, json, readJson } from "@/server/http"
import { createBoard, listBoardSummaries } from "@/server/store"

export const dynamic = "force-dynamic"

// The boards and their settings, without the cards — for a client that is not the browser
// (the notifier asks which boards it should watch). The browser reads GET /api/state.
export const GET = handle(async () => json({ boards: listBoardSummaries() }))

export const POST = handle(async (request: Request) => {
  const body = await readJson(request)
  return json(
    createBoard({
      name: body.name,
      repoPath: body.repoPath,
      createRepo: body.createRepo,
      memberIds: body.memberIds,
      checkCommand: body.checkCommand,
      starterCard: body.starterCard,
      architectEnabled: body.architectEnabled,
      notificationsEnabled: body.notificationsEnabled,
      notificationsDetailed: body.notificationsDetailed,
      oneCardAtATime: body.oneCardAtATime,
    }),
    { status: 201 }
  )
})
