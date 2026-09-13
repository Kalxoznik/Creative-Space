import type { DatabaseSync } from "node:sqlite"
import { BOARDS as DEMO_BOARDS } from "@/lib/kanban-data"
import type { ColumnRole, Priority } from "@/lib/types"

// First-launch content: the three participants of the real board, the
// demo boards from the Figma layout (kept as visual reference), and the
// Creative Space board itself — which tracks this very project.

type SeedMember = {
  id: string
  name: string
  handle: string
  initials: string
  tone: string
  kind: "human" | "agent"
  agentRole: "architect" | "coder" | null
}

const MEMBERS: SeedMember[] = [
  {
    id: "max",
    name: "Max Shakurov",
    handle: "max",
    initials: "MS",
    tone: "amber",
    kind: "human",
    agentRole: null,
  },
  {
    id: "architect",
    name: "Architect (Claude)",
    handle: "architect",
    initials: "AR",
    tone: "purple",
    kind: "agent",
    agentRole: "architect",
  },
  {
    id: "coder",
    name: "Coder (Claude)",
    handle: "coder",
    initials: "CD",
    tone: "blue",
    kind: "agent",
    agentRole: "coder",
  },
  // Demo people from the Figma layout
  {
    id: "may",
    name: "May Sh",
    handle: "may",
    initials: "MS",
    tone: "amber",
    kind: "human",
    agentRole: null,
  },
  {
    id: "emily",
    name: "Emily Mitchell",
    handle: "emily",
    initials: "EM",
    tone: "blue",
    kind: "human",
    agentRole: null,
  },
  {
    id: "jordan",
    name: "Jordan Kim",
    handle: "jordan",
    initials: "JK",
    tone: "purple",
    kind: "human",
    agentRole: null,
  },
]

const DEMO_INITIALS_TO_ID: Record<string, string> = {
  MS: "may",
  EM: "emily",
  JK: "jordan",
}

export const WORK_COLUMNS: Array<{ id: string; title: string; role: ColumnRole }> = [
  { id: "backlog", title: "Backlog", role: "backlog" },
  { id: "ready", title: "Ready", role: "ready" },
  { id: "in_progress", title: "In progress", role: "in_progress" },
  { id: "review", title: "Review", role: "review" },
  { id: "done", title: "Done", role: "done" },
]

type SeedTask = {
  column: string
  title: string
  description: string
  priority: Priority
  assignees?: string[]
}

const CREATIVE_SPACE_TASKS: SeedTask[] = [
  {
    column: "done",
    title: "Persist board state in SQLite",
    description:
      "Boards, columns, tasks, members, chat and agent runs live in data/board.db (node:sqlite). Nothing is lost on reload.",
    priority: "HIGH",
    assignees: ["architect"],
  },
  {
    column: "done",
    title: "API routes + live updates",
    description:
      "REST routes under /api for state, tasks and messages; /api/events streams changes (SSE) so every open tab and the agent worker see the same board.",
    priority: "HIGH",
    assignees: ["architect"],
  },
  {
    column: "done",
    title: "Create, edit, move and delete tasks from the UI",
    description:
      "Create task modal writes through the API; the edit button in the panel opens the same form; drag-and-drop persists column and order.",
    priority: "MEDIUM",
    assignees: ["architect"],
  },
  {
    column: "done",
    title: "Agent worker with stub mode",
    description:
      "agents/worker.mjs polls the board, claims one run at a time, and answers as Architect or Coder. Stub mode exercises the whole loop without calling any model.",
    priority: "HIGH",
    assignees: ["architect"],
  },
  {
    column: "ready",
    title: "Live mode: Claude Code for Architect, Codex CLI for Coder",
    description:
      "Wire the real adapters: `claude -p` (read-only tools) for the architect, `codex exec --full-auto` for the coder. Runs on Max's subscriptions; enable with CS_AGENT_MODE=live. Waiting for Max's go — this spends model quota.",
    priority: "HIGH",
    assignees: ["architect", "coder"],
  },
  {
    column: "backlog",
    title: "Run log viewer with changed files",
    description:
      "Show the coder's run log and the list of touched files in the task panel, not just the summary message.",
    priority: "MEDIUM",
    assignees: ["coder"],
  },
  {
    column: "backlog",
    title: "Board-level chat",
    description:
      "A channel that is not tied to a task, for planning what to do next. Architect can turn a decision into new backlog cards.",
    priority: "MEDIUM",
    assignees: ["architect"],
  },
  {
    column: "backlog",
    title: "Attachments on tasks",
    description:
      "Screenshots and Figma exports attached to a card; the coder gets file paths in its prompt.",
    priority: "LOW",
    assignees: ["coder"],
  },
  {
    column: "backlog",
    title: "Table and Calendar views",
    description: "The two workspace views in the sidebar are still placeholders.",
    priority: "LOW",
    assignees: ["coder"],
  },
]

function ts(offsetMs = 0): string {
  return new Date(Date.now() + offsetMs).toISOString()
}

export function seedIfEmpty(db: DatabaseSync): void {
  const row = db.prepare("SELECT COUNT(*) AS n FROM boards").get() as { n: number }
  if (row.n > 0) return

  db.exec("BEGIN")
  try {
    const insertMember = db.prepare(
      "INSERT INTO members (id, name, handle, initials, tone, kind, agent_role) VALUES (?, ?, ?, ?, ?, ?, ?)"
    )
    for (const m of MEMBERS) {
      insertMember.run(m.id, m.name, m.handle, m.initials, m.tone, m.kind, m.agentRole)
    }

    const insertBoard = db.prepare(
      "INSERT INTO boards (id, name, icon, kind, repo_path, position) VALUES (?, ?, ?, ?, ?, ?)"
    )
    const insertColumn = db.prepare(
      "INSERT INTO columns (id, board_id, title, role, position) VALUES (?, ?, ?, ?, ?)"
    )
    const insertBoardMember = db.prepare(
      "INSERT INTO board_members (board_id, member_id, position) VALUES (?, ?, ?)"
    )
    const insertTask = db.prepare(
      "INSERT INTO tasks (id, board_id, column_id, position, title, description, priority, attachments, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
    const insertAssignee = db.prepare(
      "INSERT INTO task_assignees (task_id, member_id, position) VALUES (?, ?, ?)"
    )
    const insertMessage = db.prepare(
      "INSERT INTO messages (task_id, author_id, kind, text, created_at) VALUES (?, ?, ?, ?, ?)"
    )

    // --- The real board ---------------------------------------------------
    insertBoard.run("creative-space", "Creative Space", "/icons/layout-grid.svg", "work", null, 0)
    WORK_COLUMNS.forEach((column, index) => {
      insertColumn.run(`creative-space:${column.id}`, "creative-space", column.title, column.role, index)
    })
    ;["max", "architect", "coder"].forEach((memberId, index) => {
      insertBoardMember.run("creative-space", memberId, index)
    })
    const positions: Record<string, number> = {}
    CREATIVE_SPACE_TASKS.forEach((task, index) => {
      const columnId = `creative-space:${task.column}`
      const position = positions[columnId] ?? 0
      positions[columnId] = position + 1
      const id = `cs-${index + 1}`
      const at = ts(-(CREATIVE_SPACE_TASKS.length - index) * 60_000)
      insertTask.run(id, "creative-space", columnId, position, task.title, task.description, task.priority, 0, at, at)
      ;(task.assignees ?? []).forEach((memberId, assigneeIndex) => {
        insertAssignee.run(id, memberId, assigneeIndex)
      })
    })
    insertMessage.run(
      "cs-5",
      "architect",
      "chat",
      "@max the stub loop works end to end. Say the word and I switch CS_AGENT_MODE to live — from then on every run spends quota on your Claude and ChatGPT plans.",
      ts(-30_000)
    )

    // --- Demo boards from the Figma layout ---------------------------------
    DEMO_BOARDS.forEach((board, boardIndex) => {
      insertBoard.run(board.id, board.name, board.icon, "demo", null, boardIndex + 1)
      ;["may", "emily", "jordan"].forEach((memberId, index) => {
        insertBoardMember.run(board.id, memberId, index)
      })
      board.columns.forEach((column, columnIndex) => {
        const columnId = `${board.id}:${column.id}`
        const role: ColumnRole =
          column.id === "backlog" ? "backlog" : column.id === "todo" ? "ready" : "other"
        insertColumn.run(columnId, board.id, column.title, role, columnIndex)
        column.cards.forEach((card, cardIndex) => {
          const taskId = `${board.id}:${card.id}`
          const at = ts(-(cardIndex + 1) * 3_600_000)
          const isFeatured = card.id === board.detailCardId && board.detail
          insertTask.run(
            taskId,
            board.id,
            columnId,
            cardIndex,
            card.title,
            isFeatured ? board.detail!.description : card.description,
            card.priority,
            card.attachments ?? 0,
            at,
            at
          )
          const seen = new Set<string>()
          card.assignees.forEach((person, assigneeIndex) => {
            const memberId = DEMO_INITIALS_TO_ID[person.initials]
            if (!memberId || seen.has(memberId)) return
            seen.add(memberId)
            insertAssignee.run(taskId, memberId, assigneeIndex)
          })
        })
      })
      if (board.detailCardId && board.detail) {
        const taskId = `${board.id}:${board.detailCardId}`
        board.detail.messages.forEach((message, index) => {
          const authorId = DEMO_INITIALS_TO_ID[message.initials] ?? "may"
          insertMessage.run(
            taskId,
            authorId,
            "chat",
            message.text,
            ts(-(board.detail!.messages.length - index) * 240_000)
          )
        })
      }
    })

    db.exec("COMMIT")
  } catch (error) {
    db.exec("ROLLBACK")
    throw error
  }
}
