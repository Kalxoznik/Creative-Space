import type {
  AgentConfig,
  AgentRole,
  AvatarTone,
  Board,
  BoardState,
  Column,
  Member,
  Message,
  RepoCheck,
  Run,
  Task,
  TaskThread,
} from "./types"

/** Fields of the agent form; every one is optional on update. */
export type AgentInput = Partial<AgentConfig> & { name?: string; handle?: string; role?: AgentRole; tone?: AvatarTone }

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

  /** First-launch profile and the Settings → Profile form. */
  updateMe: (patch: { name?: string; handle?: string }) =>
    request<Member>("/api/me", { method: "PATCH", body: JSON.stringify(patch) }),

  /** Does this folder exist, is it a git repo, does it have CLAUDE.md / AGENTS.md? */
  checkRepo: (path: string) => request<RepoCheck>(`/api/repo-check?path=${encodeURIComponent(path)}`),

  /** Which folder a new board with this name would get, when the board creates it itself. */
  suggestRepo: (name: string) => request<RepoCheck>(`/api/repo-check?name=${encodeURIComponent(name)}`),

  createAgent: (input: AgentInput) => request<Member>("/api/agents", { method: "POST", body: JSON.stringify(input) }),

  updateAgent: (agentId: string, patch: AgentInput) =>
    request<Member>(`/api/agents/${encodeURIComponent(agentId)}`, { method: "PATCH", body: JSON.stringify(patch) }),

  removeAgent: (agentId: string) =>
    request<{ ok: true }>(`/api/agents/${encodeURIComponent(agentId)}`, { method: "DELETE" }),

  createBoard: (input: {
    name: string
    repoPath?: string
    /** No repoPath: the server makes the folder (git init + CLAUDE.md / AGENTS.md) itself. */
    createRepo?: boolean
    memberIds?: string[]
    checkCommand?: string
    /** Add a Ready card asking the Coder to write CLAUDE.md for the project. */
    starterCard?: boolean
    /** false = no architect agent on this board; see `Board.architectEnabled`. */
    architectEnabled?: boolean
    /** false = the owner is not notified about this board; see `Board.notificationsEnabled`. */
    notificationsEnabled?: boolean
    /** false = notifications carry no agent text; see `Board.notificationsDetailed`. */
    notificationsDetailed?: boolean
    /** false = Ready starts the next card while one is still in Review; see `Board.oneCardAtATime`. */
    oneCardAtATime?: boolean
  }) => request<Board>("/api/boards", { method: "POST", body: JSON.stringify(input) }),

  updateBoard: (
    boardId: string,
    patch: {
      name?: string
      /** Card-number prefix (2–4 characters, `BI` in `BI-12`). */
      key?: string
      repoPath?: string
      archived?: boolean
      memberIds?: string[]
      checkCommand?: string
      architectEnabled?: boolean
      notificationsEnabled?: boolean
      notificationsDetailed?: boolean
      oneCardAtATime?: boolean
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

  updateColumn: (columnId: string, patch: { title?: string; role?: string; position?: number }) =>
    request<Column>(`/api/columns/${encodeURIComponent(columnId)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),

  archivedTasks: (boardId: string) =>
    request<{ tasks: Task[] }>(`/api/boards/${encodeURIComponent(boardId)}/archived`),

  archiveColumn: (columnId: string) =>
    request<{ archived: number }>(`/api/columns/${encodeURIComponent(columnId)}/archive`, { method: "POST" }),

  deleteColumn: (columnId: string, cards?: "delete" | "archive") =>
    request<{ ok: true }>(
      `/api/columns/${encodeURIComponent(columnId)}${cards ? `?cards=${cards}` : ""}`,
      { method: "DELETE" }
    ),

  createTask: (input: {
    boardId: string
    columnId?: string
    title: string
    description?: string
    assigneeIds?: string[]
  }) => request<Task>("/api/tasks", { method: "POST", body: JSON.stringify(input) }),

  updateTask: (
    taskId: string,
    patch: {
      title?: string
      description?: string
      assigneeIds?: string[]
      columnId?: string
      position?: number
      archived?: boolean
      blockedBy?: string[]
    }
  ) =>
    request<Task>(`/api/tasks/${encodeURIComponent(taskId)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),

  /** Take the “waiting for the owner” flag off a card — the button on its badge. */
  clearNeedsOwner: (taskId: string) =>
    request<{ cleared: boolean }>(`/api/tasks/${encodeURIComponent(taskId)}/needs-owner`, { method: "DELETE" }),

  /** Stop a run: a queued one is cancelled at once, a running one is killed by the worker. */
  cancelRun: (runId: number) =>
    request<Run>(`/api/agents/runs/${runId}/cancel`, { method: "POST" }),

  deleteTask: (taskId: string) =>
    request<{ ok: true }>(`/api/tasks/${encodeURIComponent(taskId)}`, { method: "DELETE" }),

  sendMessage: (taskId: string, text: string) =>
    request<Message>(`/api/tasks/${encodeURIComponent(taskId)}/messages`, {
      method: "POST",
      body: JSON.stringify({ text }),
    }),

  // Multipart, so it can't go through request() and its JSON Content-Type.
  uploadImage: async (file: Blob) => {
    const form = new FormData()
    form.append("file", file)
    const response = await fetch("/api/uploads", { method: "POST", body: form, cache: "no-store" })
    const body = (await response.json().catch(() => ({}))) as { url?: string; error?: string }
    if (!response.ok || !body.url) throw new Error(body.error ?? `${response.status} ${response.statusText}`)
    return body as { url: string }
  },
}
