import { handle, json, readJson } from "@/server/http"
import { createTask } from "@/server/store"

export const dynamic = "force-dynamic"

export const POST = handle(async (request: Request) => {
  const body = await readJson(request)
  const task = createTask({
    boardId: body.boardId,
    columnId: body.columnId,
    title: body.title,
    description: body.description,
    priority: body.priority,
    assigneeIds: body.assigneeIds,
  })
  return json(task, { status: 201 })
})
