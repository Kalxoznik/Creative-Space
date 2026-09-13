import type { Board, BoardEngines, BoardState, Column, Message, Priority, Task, TaskThread } from "./types"

// Thin client for the board API. Every call returns the server's view;
// the SSE stream (/api/events) tells the UI when to refetch.

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    cache: "no-store",
  })
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`
    try {
      const body = (await response.json()) as { error?: string }
      if (body.error) message = body.error
    } catch {
      // keep status text
    }
    throw new Error(message)
  }
  return (await response.json()) as T
}

export const api = {
  state: () => request<BoardState>("/api/state"),

  thread: (taskId: string) => request<TaskThread>(`/api/tasks/${encodeURIComponent(taskId)}`),

  createBoard: (input: { name: string; repoPath?: string }) =>
    request<Board>("/api/boards", { method: "POST", body: JSON.stringify(input) }),

  updateBoard: (
    boardId: string,
    patch: {
      name?: string
      repoPath?: string
      archived?: boolean
      memberIds?: string[]
      engines?: Partial<BoardEngines>
    }
  ) =>
    request<Board>(`/api/boards/${encodeURIComponent(boardId)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),

  deleteBoard: (boardId: string) =>
    request<{ ok: true }>(`/api/boards/${encodeURIComponent(boardId)}`, { method: "DELETE" }),

  createColumn: (boardId: string, input: { title: string; role?: string }) =>
    request<Column>(`/api/boards/${encodeURIComponent(boardId)}/columns`, {
      method: "POST",
      body: JSON.stringify(input),
    }),

  updateColumn: (columnId: string, patch: { title?: string; role?: string }) =>
    request<Column>(`/api/columns/${encodeURIComponent(columnId)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),

  deleteColumn: (columnId: string) =>
    request<{ ok: true }>(`/api/columns/${encodeURIComponent(columnId)}`, { method: "DELETE" }),

  createTask: (input: {
    boardId: string
    columnId?: string
    title: string
    description?: string
    priority?: Priority
    assigneeIds?: string[]
  }) => request<Task>("/api/tasks", { method: "POST", body: JSON.stringify(input) }),

  updateTask: (
    taskId: string,
    patch: {
      title?: string
      description?: string
      priority?: Priority
      assigneeIds?: string[]
      columnId?: string
      position?: number
    }
  ) =>
    request<Task>(`/api/tasks/${encodeURIComponent(taskId)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),

  deleteTask: (taskId: string) =>
    request<{ ok: true }>(`/api/tasks/${encodeURIComponent(taskId)}`, { method: "DELETE" }),

  sendMessage: (taskId: string, text: string) =>
    request<Message>(`/api/tasks/${encodeURIComponent(taskId)}/messages`, {
      method: "POST",
      body: JSON.stringify({ text }),
    }),
}
