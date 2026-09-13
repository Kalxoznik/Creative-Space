import type { DatabaseSync } from "node:sqlite"
import type { ColumnRole } from "@/lib/types"

// First launch of a fresh database: the owner (unnamed until the welcome screen)
// and the two agents. No boards — the first one is created from the UI, where
// the project folder and the agents for it are chosen.

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
    db.exec("COMMIT")
  } catch (error) {
    db.exec("ROLLBACK")
    throw error
  }
}
