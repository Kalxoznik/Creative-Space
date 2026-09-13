import type { DatabaseSync } from "node:sqlite"
import type { ColumnRole } from "@/lib/types"

// First launch of a fresh database: the owner (unnamed until the welcome screen),
// the two agents, and one example board — Creative Space's own tracker, pointed at
// this very repository, with a few real ideas in Backlog to try the agents on.

type SeedMember = {
  id: string
  name: string
  handle: string
  initials: string
  tone: string
  kind: "human" | "agent"
  agentRole: "architect" | "coder" | null
  isOwner: boolean
}

export const OWNER_ID = "owner"

const MEMBERS: SeedMember[] = [
  {
    id: OWNER_ID,
    name: "",
    handle: "owner",
    initials: "?",
    tone: "amber",
    kind: "human",
    agentRole: null,
    isOwner: true,
  },
  {
    id: "architect",
    name: "Architect (Claude)",
    handle: "architect",
    initials: "AR",
    tone: "purple",
    kind: "agent",
    agentRole: "architect",
    isOwner: false,
  },
  {
    id: "coder",
    name: "Coder (Claude)",
    handle: "coder",
    initials: "CD",
    tone: "blue",
    kind: "agent",
    agentRole: "coder",
    isOwner: false,
  },
]

export const WORK_COLUMNS: Array<{ id: string; title: string; role: ColumnRole }> = [
  { id: "backlog", title: "Backlog", role: "backlog" },
  { id: "ready", title: "Ready", role: "ready" },
  { id: "in_progress", title: "In progress", role: "in_progress" },
  { id: "review", title: "Review", role: "review" },
  { id: "done", title: "Done", role: "done" },
]

/** The example board: ideas for this tool itself. All in Backlog, so nothing runs until you say so. */
const EXAMPLE_BOARD = { id: "creative-space", name: "Creative Space" }
const EXAMPLE_TASKS: Array<{ title: string; description: string; priority: string; assignees: string[] }> = [
  {
    title: "Run log viewer with changed files",
    description:
      "Show the Coder's run log and the list of touched files in the task panel, not just the summary message.",
    priority: "MEDIUM",
    assignees: ["coder"],
  },
  {
    title: "Board-level chat",
    description:
      "A channel that is not tied to a task, for planning what to do next. The Architect can turn a decision into new Backlog cards.",
    priority: "MEDIUM",
    assignees: ["architect"],
  },
  {
    title: "Table and Calendar views",
    description: "The two workspace views in the sidebar are still placeholders.",
    priority: "LOW",
    assignees: ["coder"],
  },
]

export function seedIfEmpty(db: DatabaseSync): void {
  const row = db.prepare("SELECT COUNT(*) AS n FROM members").get() as { n: number }
  if (row.n > 0) return

  db.exec("BEGIN")
  try {
    const insertMember = db.prepare(
      "INSERT INTO members (id, name, handle, initials, tone, kind, agent_role, is_owner) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    )
    for (const m of MEMBERS) {
      insertMember.run(m.id, m.name, m.handle, m.initials, m.tone, m.kind, m.agentRole, m.isOwner ? 1 : 0)
    }

    // repo_path NULL = the folder this board is running from, i.e. this repository.
    db.prepare("INSERT INTO boards (id, name, icon, kind, repo_path, position) VALUES (?, ?, ?, 'work', NULL, 0)").run(
      EXAMPLE_BOARD.id,
      EXAMPLE_BOARD.name,
      "/icons/layout-grid.svg"
    )
    WORK_COLUMNS.forEach((column, index) => {
      db.prepare("INSERT INTO columns (id, board_id, title, role, position) VALUES (?, ?, ?, ?, ?)").run(
        `${EXAMPLE_BOARD.id}:${column.id}`,
        EXAMPLE_BOARD.id,
        column.title,
        column.role,
        index
      )
    })
    MEMBERS.forEach((m, index) => {
      db.prepare("INSERT INTO board_members (board_id, member_id, position) VALUES (?, ?, ?)").run(
        EXAMPLE_BOARD.id,
        m.id,
        index
      )
    })
    const insertTask = db.prepare(
      "INSERT INTO tasks (id, board_id, column_id, position, title, description, priority, attachments, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)"
    )
    const insertAssignee = db.prepare("INSERT INTO task_assignees (task_id, member_id, position) VALUES (?, ?, ?)")
    EXAMPLE_TASKS.forEach((task, index) => {
      const id = `cs-${index + 1}`
      const at = new Date(Date.now() - (EXAMPLE_TASKS.length - index) * 60_000).toISOString()
      insertTask.run(id, EXAMPLE_BOARD.id, `${EXAMPLE_BOARD.id}:backlog`, index, task.title, task.description, task.priority, at, at)
      task.assignees.forEach((memberId, position) => insertAssignee.run(id, memberId, position))
    })
    db.exec("COMMIT")
  } catch (error) {
    db.exec("ROLLBACK")
    throw error
  }
}
