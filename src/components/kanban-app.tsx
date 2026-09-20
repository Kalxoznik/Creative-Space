"use client"

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react"
import type { ClipboardEvent, ReactNode } from "react"
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCenter,
  closestCorners,
  pointerWithin,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core"
import {
  SortableContext,
  arrayMove,
  horizontalListSortingStrategy,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import { AVATAR_STYLES, PRIORITY_STYLES } from "@/lib/kanban-data"
import { api } from "@/lib/api"
import type { AgentInput } from "@/lib/api"
import { AGENT_EFFORTS, AVATAR_TONES, PRIORITIES } from "@/lib/types"
import type {
  AgentEffort,
  AgentEngine,
  AgentRole,
  AvatarTone,
  Board,
  BoardState,
  ColumnRole,
  Member,
  Message,
  Priority,
  RepoCheck,
  Run,
  Task,
  TaskThread,
  WorkerStatus,
} from "@/lib/types"
import { cn } from "@/lib/utils"

// ---------------------------------------------------------------------------
// View types — what the board renders. Tasks come from the API; assignees are
// resolved to members here so the card components stay dumb.

type CardView = Task & { assignees: Member[]; selected: boolean; /** Titles of the open cards this one waits for. */ waitingFor: string[] }

type ColumnView = {
  id: string
  title: string
  role: ColumnRole
  cards: CardView[]
}

type Selection = { selectedId: string | null; panelOpen: boolean }

type ModalState =
  | { mode: "create"; columnId?: string }
  | { mode: "edit"; task: Task }

// ---------------------------------------------------------------------------
// Small helpers

const inputClass =
  "w-full rounded-lg border border-cw-border bg-white px-3 py-2.5 text-[13px] text-cw-text placeholder:text-cw-placeholder outline-none focus:border-cw-accent"

/**
 * Drop where the pointer is: the card or column under the cursor wins. Only
 * when the pointer is outside every droppable (e.g. over the board's edge)
 * fall back to geometry, so empty columns are as easy to hit as full ones.
 */
// Lists are sortable too; their ids are prefixed so they never clash with a list's card drop zone.
const COLUMN_DRAG_PREFIX = "col:"

const collisionDetection: CollisionDetection = (args) => {
  const draggingColumn = args.active.data.current?.type === "column"
  const droppableContainers = args.droppableContainers.filter(
    (container) => (container.data.current?.type === "column") === draggingColumn
  )
  if (draggingColumn) return closestCenter({ ...args, droppableContainers })
  args = { ...args, droppableContainers }
  const underPointer = pointerWithin(args)
  if (underPointer.length > 0) return underPointer
  return closestCorners(args)
}

const subscribeNoop = () => () => {}
const getClientTrue = () => true
const getServerFalse = () => false

function getMentionQuery(value: string): string | null {
  const match = value.match(/(?:^|\s)@([\w]*)$/)
  return match ? match[1].toLowerCase() : null
}

function renderMessageText(text: string, byHandle: Map<string, Member>) {
  const parts = text.split(/(@[A-Za-z][\w]*)/g)
  return parts.map((part, index) => {
    if (part.startsWith("@") && part.length > 1) {
      const member = byHandle.get(part.slice(1).toLowerCase())
      const color = member ? AVATAR_STYLES[member.tone].text : "#c48400"
      return (
        <span key={`${part}-${index}`} className="font-semibold" style={{ color }}>
          {part}
        </span>
      )
    }
    return <span key={`${part}-${index}`}>{part}</span>
  })
}

// Pasted images are stored as markdown: ![image](/api/uploads/<name>)
const IMAGE_RE = /!\[[^\]]*\]\((\/api\/uploads\/[a-z0-9]+\.(?:png|jpg|gif|webp))\)/g

/** Message/description text with @mentions highlighted and pasted images shown inline. */
function renderRichText(text: string, byHandle: Map<string, Member>) {
  const nodes: ReactNode[] = []
  let last = 0
  for (const match of text.matchAll(IMAGE_RE)) {
    const index = match.index ?? 0
    if (index > last) nodes.push(...renderMessageText(text.slice(last, index), byHandle))
    nodes.push(
      <a key={`img-${index}`} href={match[1]} target="_blank" rel="noreferrer" className="my-1 block">
        {/* eslint-disable-next-line @next/next/no-img-element -- local user uploads, no optimization needed */}
        <img src={match[1]} alt="Pasted image" className="max-h-60 max-w-full rounded border border-cw-border" />
      </a>
    )
    last = index + match[0].length
  }
  if (last < text.length) nodes.push(...renderMessageText(text.slice(last), byHandle))
  return nodes
}

/** Card previews have no room for images — show a short marker instead of the markdown. */
function stripImages(text: string): string {
  return text.replace(IMAGE_RE, "[image]")
}

/**
 * Ctrl+V handler for text fields: uploads clipboard images and inserts their markdown
 * at the cursor. Plain-text pastes are left to the browser.
 */
function handleImagePaste(
  event: ClipboardEvent<HTMLInputElement | HTMLTextAreaElement>,
  setValue: (update: (prev: string) => string) => void,
  onError: (message: string) => void
) {
  const files = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith("image/"))
  if (files.length === 0) return
  event.preventDefault()
  const field = event.currentTarget
  const start = field.selectionStart ?? field.value.length
  const end = field.selectionEnd ?? start
  void (async () => {
    try {
      const uploads = await Promise.all(files.map((file) => api.uploadImage(file)))
      const markdown = uploads.map((upload) => `![image](${upload.url})`).join(" ")
      setValue((prev) => {
        const before = prev.slice(0, start)
        const after = prev.slice(end)
        const pad = (s: string, edge: string) => (s && !/\s/.test(edge) ? " " : "")
        return `${before}${pad(before, before.slice(-1))}${markdown}${pad(after, after.charAt(0))}${after}`
      })
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not upload the image")
    }
  })()
}

function formatTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ""
  const now = new Date()
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
  if (sameDay) return time
  return `${date.toLocaleDateString([], { day: "numeric", month: "short" })}, ${time}`
}

function findColumnId(columns: ColumnView[], itemId: string): string | undefined {
  if (columns.some((column) => column.id === itemId)) return itemId
  return columns.find((column) => column.cards.some((card) => card.id === itemId))?.id
}

function findCard(columns: ColumnView[], cardId: string): CardView | undefined {
  for (const column of columns) {
    const card = column.cards.find((item) => item.id === cardId)
    if (card) return card
  }
  return undefined
}

function shortName(member: Member | undefined): string {
  if (!member) return "Agent"
  return member.name.replace(/\s*\(.*\)\s*$/, "")
}

function agentStatusLabel(card: Task, byId: Map<string, Member>): string | null {
  if (!card.agentStatus) return null
  const agent = byId.get(card.agentStatus.agentId)
  const verb =
    card.agentStatus.status === "queued"
      ? "queued"
      : card.agentStatus.trigger === "dispatch"
        ? "sorting the queue"
        : agent?.agentRole === "coder"
          ? "working"
          : "thinking"
  return `${shortName(agent)} · ${verb}`
}

const ENGINE_LABELS: Record<AgentEngine, string> = { claude: "Claude Code", codex: "Codex CLI", stub: "Stub (no model)" }
const EFFORT_LABELS: Record<AgentEffort, string> = { low: "Low", medium: "Medium", high: "High", max: "Max" }

/** "Claude Code · opus · High effort · 40 turns" */
function agentConfigLabel(agent: Member): string {
  const c = agent.agent
  if (!c) return ""
  return [ENGINE_LABELS[c.engine], c.model, c.effort && `${EFFORT_LABELS[c.effort]} effort`, c.maxTurns && `${c.maxTurns} turns`]
    .filter(Boolean)
    .join(" · ")
}

// ---------------------------------------------------------------------------
// Presentational pieces (unchanged look from the Figma layout)

function Icon({
  src,
  alt = "",
  size,
  className,
}: {
  src: string
  alt?: string
  size: number
  className?: string
}) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={src} alt={alt} width={size} height={size} className={cn("shrink-0", className)} />
  )
}

function Avatar({
  initials,
  tone,
  size = 22,
  className,
  title,
}: {
  initials: string
  tone: AvatarTone
  size?: number
  className?: string
  title?: string
}) {
  const style = AVATAR_STYLES[tone]
  return (
    <span
      title={title}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full font-bold",
        className
      )}
      style={{
        width: size,
        height: size,
        backgroundColor: style.bg,
        color: style.text,
        fontSize: size <= 24 ? 9 : 12,
      }}
    >
      {initials}
    </span>
  )
}

function UserMenu({ me, onOpenSettings }: { me: Member; onOpenSettings: () => void }) {
  const [open, setOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false)
    }
    document.addEventListener("mousedown", onPointerDown)
    document.addEventListener("keydown", onKeyDown)
    return () => {
      document.removeEventListener("mousedown", onPointerDown)
      document.removeEventListener("keydown", onKeyDown)
    }
  }, [open])

  return (
    <div className="relative" ref={menuRef}>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Account menu"
        onClick={() => setOpen((value) => !value)}
        className={cn(
          "rounded-full outline-none transition ring-offset-2 hover:opacity-90 focus-visible:ring-2 focus-visible:ring-[#e8ab24]",
          open && "ring-2 ring-[#e8ab24]"
        )}
      >
        <Avatar initials={me.initials} tone={me.tone} size={32} />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute top-full right-0 z-40 mt-2 w-[220px] overflow-hidden rounded-xl border border-cw-border bg-white shadow-[0_12px_32px_rgba(0,0,0,0.12)]"
        >
          <div className="flex items-center gap-2.5 border-b border-cw-border px-3 py-3">
            <Avatar initials={me.initials} tone={me.tone} size={36} />
            <div className="min-w-0">
              <p className="truncate text-[13px] font-semibold text-cw-text">{me.name}</p>
              <p className="truncate text-[11px] text-cw-placeholder">@{me.handle} · owner</p>
            </div>
          </div>
          <div className="p-1.5">
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false)
                onOpenSettings()
              }}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[12px] font-medium text-cw-text hover:bg-[#fff8e9]"
            >
              <Icon src="/icons/settings.svg" size={14} />
              Settings
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function SettingsModal({ me, onClose, onSaved }: { me: Member; onClose: () => void; onSaved: () => void }) {
  const [activeTab, setActiveTab] = useState<"profile" | "workspace" | "notifications">("profile")
  const [displayName, setDisplayName] = useState(me.name)
  const [handle, setHandle] = useState(me.handle)
  const [workspaceName, setWorkspaceName] = useState("Creative Space")
  const [emailAlerts, setEmailAlerts] = useState(true)
  const [mentionAlerts, setMentionAlerts] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const profileChanged = displayName.trim() !== me.name || handle.trim().replace(/^@/, "") !== me.handle

  const save = async () => {
    if (!profileChanged) {
      onClose()
      return
    }
    setBusy(true)
    setError(null)
    try {
      await api.updateMe({ name: displayName.trim(), handle: handle.trim() })
      onSaved()
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save")
      setBusy(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-[4px]"
      role="dialog"
      aria-modal="true"
      aria-labelledby="settings-title"
      onClick={onClose}
    >
      <div
        className="cw-modal-shadow flex max-h-[min(640px,90vh)] w-[560px] max-w-[calc(100vw-32px)] flex-col overflow-hidden rounded-xl border border-cw-border bg-white"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-cw-border py-4 pl-5 pr-4">
          <h2 id="settings-title" className="text-lg font-bold text-cw-text">
            Settings
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="flex size-7 items-center justify-center rounded-md border border-cw-border bg-cw-bg text-base font-bold text-cw-secondary hover:bg-[#eceae6]"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <div className="flex min-h-0 flex-1">
          <nav className="flex w-[160px] shrink-0 flex-col gap-1 border-r border-cw-border bg-[#fafaf8] p-3">
            {(
              [
                ["profile", "Profile"],
                ["workspace", "Workspace"],
                ["notifications", "Notifications"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => setActiveTab(id)}
                className={cn(
                  "rounded-lg px-3 py-2 text-left text-[12px] font-semibold",
                  activeTab === id ? "bg-white text-cw-text shadow-sm" : "text-cw-secondary hover:bg-white/70"
                )}
              >
                {label}
              </button>
            ))}
          </nav>

          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-5">
            {activeTab === "profile" && (
              <>
                <div className="flex items-center gap-3">
                  <Avatar initials={me.initials} tone={me.tone} size={48} />
                  <div>
                    <p className="text-[13px] font-semibold text-cw-text">{me.name}</p>
                    <p className="text-[11px] text-cw-placeholder">Avatar colors follow your initials</p>
                  </div>
                </div>
                <label className="flex w-full flex-col gap-1.5">
                  <span className="text-xs font-semibold text-cw-secondary">Display name</span>
                  <input
                    value={displayName}
                    onChange={(event) => setDisplayName(event.target.value)}
                    className="w-full rounded-lg border border-cw-border bg-white px-3 py-2.5 text-[13px] text-cw-text outline-none focus:border-cw-accent"
                  />
                </label>
                <label className="flex w-full flex-col gap-1.5">
                  <span className="text-xs font-semibold text-cw-secondary">Handle</span>
                  <input
                    value={handle}
                    onChange={(event) => setHandle(event.target.value)}
                    className="w-full rounded-lg border border-cw-border bg-white px-3 py-2.5 text-[13px] text-cw-text outline-none focus:border-cw-accent"
                  />
                </label>
              </>
            )}

            {activeTab === "workspace" && (
              <>
                <label className="flex w-full flex-col gap-1.5">
                  <span className="text-xs font-semibold text-cw-secondary">Workspace name</span>
                  <input
                    value={workspaceName}
                    onChange={(event) => setWorkspaceName(event.target.value)}
                    className="w-full rounded-lg border border-cw-border bg-white px-3 py-2.5 text-[13px] text-cw-text outline-none focus:border-cw-accent"
                  />
                </label>
                <p className="text-[12px] leading-[1.4] text-cw-secondary">
                  Members, boards and chat history live in data/board.db next to the project. The workspace
                  name is not saved yet.
                </p>
              </>
            )}

            {activeTab === "notifications" && (
              <>
                <label className="flex items-center justify-between gap-3 rounded-lg border border-cw-border px-3 py-3">
                  <span>
                    <span className="block text-[13px] font-semibold text-cw-text">Email alerts</span>
                    <span className="block text-[11px] text-cw-placeholder">Digest for board activity</span>
                  </span>
                  <input
                    type="checkbox"
                    checked={emailAlerts}
                    onChange={(event) => setEmailAlerts(event.target.checked)}
                    className="size-4 accent-[#f2a000]"
                  />
                </label>
                <label className="flex items-center justify-between gap-3 rounded-lg border border-cw-border px-3 py-3">
                  <span>
                    <span className="block text-[13px] font-semibold text-cw-text">Mention notifications</span>
                    <span className="block text-[11px] text-cw-placeholder">When someone tags you in task chat</span>
                  </span>
                  <input
                    type="checkbox"
                    checked={mentionAlerts}
                    onChange={(event) => setMentionAlerts(event.target.checked)}
                    className="size-4 accent-[#f2a000]"
                  />
                </label>
              </>
            )}
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-cw-border px-5 py-4">
          {error && <p className="mr-auto text-[12px] font-medium text-[#b25959]">{error}</p>}
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-cw-border bg-white px-4 py-2.5 text-[13px] font-bold text-cw-text hover:bg-[#faf9f7]"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={busy || displayName.trim().length === 0}
            onClick={() => void save()}
            className="rounded-md bg-cw-accent px-4 py-2.5 text-[13px] font-bold text-white hover:bg-[#d99c1c] disabled:opacity-50"
          >
            {busy ? "Saving…" : "Save changes"}
          </button>
        </div>
      </div>
    </div>
  )
}

/** "Ada Lovelace" → "ada"; names without latin letters fall back to "owner". */
function suggestHandle(name: string): string {
  const first = name.trim().split(/\s+/)[0] ?? ""
  const ascii = first
    .normalize("NFKD")
    .replace(/[^\x00-\x7F]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "")
  return ascii || "owner"
}

/**
 * First launch: the workspace has an owner without a name yet. One question, no account —
 * everything stays in the local database.
 */
function WelcomeModal({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState("")
  const [handle, setHandle] = useState("")
  const [handleTouched, setHandleTouched] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const effectiveHandle = handleTouched ? handle : suggestHandle(name)
  const canSave = name.trim().length > 0 && effectiveHandle.trim().length > 0 && !busy

  const submit = async () => {
    if (!canSave) return
    setBusy(true)
    setError(null)
    try {
      await api.updateMe({ name: name.trim(), handle: effectiveHandle.trim() })
      onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save")
      setBusy(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-[4px]"
      role="dialog"
      aria-modal="true"
      aria-labelledby="welcome-title"
    >
      <form
        className="cw-modal-shadow flex w-[440px] max-w-[calc(100vw-32px)] flex-col gap-4 rounded-xl border border-cw-border bg-white p-6"
        onSubmit={(event) => {
          event.preventDefault()
          void submit()
        }}
      >
        <div className="flex items-center gap-3">
          <span className="text-[34px] font-black leading-none text-[#f2a000]">CS</span>
          <div>
            <h2 id="welcome-title" className="text-lg font-bold text-cw-text">
              Welcome to Creative Space
            </h2>
            <p className="text-[12px] text-cw-secondary">A board where you and two coding agents work on a project.</p>
          </div>
        </div>
        <label className="flex w-full flex-col gap-1.5">
          <span className="text-xs font-semibold text-cw-secondary">Your name</span>
          <input
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            className={inputClass}
            placeholder="How the agents should address you"
          />
        </label>
        <label className="flex w-full flex-col gap-1.5">
          <span className="text-xs font-semibold text-cw-secondary">Handle</span>
          <div className="flex items-center gap-1">
            <span className="text-[13px] text-cw-placeholder">@</span>
            <input
              value={effectiveHandle}
              onChange={(event) => {
                setHandleTouched(true)
                setHandle(event.target.value.replace(/^@/, ""))
              }}
              className={inputClass}
              spellCheck={false}
            />
          </div>
          <span className="text-[11px] leading-[1.4] text-cw-placeholder">
            Agents mention you as @{effectiveHandle || "…"} in task chats. Latin letters, digits and _ only.
          </span>
        </label>
        <p className="text-[11px] leading-[1.4] text-cw-placeholder">
          No account, no e-mail: this and everything else stays in data/board.db on this computer.
        </p>
        {error && <p className="text-[12px] font-medium text-[#b25959]">{error}</p>}
        <button
          type="submit"
          disabled={!canSave}
          className="rounded-md bg-cw-accent px-4 py-2.5 text-[13px] font-bold text-white hover:bg-[#d99c1c] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? "Saving…" : "Continue"}
        </button>
      </form>
    </div>
  )
}

function PriorityPill({ priority, large = false }: { priority: Priority; large?: boolean }) {
  const style = PRIORITY_STYLES[priority]
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center whitespace-nowrap rounded-full font-bold leading-none",
        large ? "h-[26px] px-3 text-[10px]" : "h-[22px] px-2.5 text-[10px]"
      )}
      style={{ backgroundColor: style.bg, color: style.text }}
    >
      {priority}
    </span>
  )
}

function AgentBadge({ card, byId, large = false }: { card: Task; byId: Map<string, Member>; large?: boolean }) {
  const label = agentStatusLabel(card, byId)
  if (!label || !card.agentStatus) return null
  const agent = byId.get(card.agentStatus.agentId)
  const style = AVATAR_STYLES[agent?.tone ?? "purple"]
  return (
    <span
      className={cn(
        "inline-flex min-w-0 items-center gap-1.5 whitespace-nowrap rounded-full font-semibold leading-none",
        large ? "h-[26px] px-3 text-[10px]" : "h-[22px] px-2 text-[9px]"
      )}
      style={{ backgroundColor: style.bg, color: style.text }}
      title={`${label} (${card.agentStatus.trigger})`}
    >
      <span
        className={cn("inline-block size-1.5 shrink-0 rounded-full", card.agentStatus.status === "running" && "cw-pulse")}
        style={{ backgroundColor: style.text }}
      />
      <span className="truncate">{label}</span>
    </span>
  )
}

function NavItem({
  icon,
  label,
  active = false,
  onClick,
}: {
  icon: string
  label: string
  active?: boolean
  onClick?: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex h-10 w-full items-center gap-3 px-[18px] text-left text-xs text-cw-text",
        active ? "border-l-[3px] border-[#f2a000] bg-[#fff8e9] font-semibold pl-[15px]" : "hover:bg-[#faf9f7]"
      )}
    >
      <Icon src={icon} size={16} />
      <span className="truncate">{label}</span>
    </button>
  )
}

function BoardNavItem({
  board,
  active,
  onSelect,
  onEdit,
  onDelete,
}: {
  board: Board
  active: boolean
  onSelect: () => void
  onEdit: () => void
  onDelete: () => void
}) {
  // The menu is position:fixed so the sidebar's scroll container never clips it.
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null)
  const open = menuPos != null
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)

  const toggle = () => {
    if (menuPos) {
      setMenuPos(null)
      return
    }
    const rect = triggerRef.current?.getBoundingClientRect()
    if (!rect) return
    setMenuPos({ top: rect.bottom + 4, left: Math.max(8, rect.right - 172) })
  }

  useEffect(() => {
    if (!open) return
    const close = () => setMenuPos(null)
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) close()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close()
    }
    document.addEventListener("mousedown", onPointerDown)
    document.addEventListener("keydown", onKeyDown)
    window.addEventListener("resize", close)
    return () => {
      document.removeEventListener("mousedown", onPointerDown)
      document.removeEventListener("keydown", onKeyDown)
      window.removeEventListener("resize", close)
    }
  }, [open])

  const pick = (action: () => void) => {
    setMenuPos(null)
    action()
  }

  return (
    <div
      ref={rootRef}
      className={cn(
        "group relative flex h-10 w-full items-center",
        active ? "border-l-[3px] border-[#f2a000] bg-[#fff8e9]" : "hover:bg-[#faf9f7]"
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        className={cn(
          "flex h-full min-w-0 flex-1 items-center gap-3 pr-1 text-left text-xs text-cw-text",
          active ? "pl-[15px] font-semibold" : "pl-[18px]"
        )}
      >
        <Icon src={board.icon} size={16} />
        <span className="truncate">{board.name}</span>
      </button>
      <button
        ref={triggerRef}
        type="button"
        aria-label={`Board menu: ${board.name}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={toggle}
        className={cn(
          "mr-2 flex size-6 shrink-0 items-center justify-center rounded-md text-cw-secondary transition-opacity hover:bg-[#eceae6] hover:text-cw-text",
          open ? "bg-[#eceae6] opacity-100" : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
        )}
      >
        <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true">
          <circle cx="7" cy="2.5" r="1.4" />
          <circle cx="7" cy="7" r="1.4" />
          <circle cx="7" cy="11.5" r="1.4" />
        </svg>
      </button>

      {menuPos && (
        <div
          role="menu"
          style={{ top: menuPos.top, left: menuPos.left }}
          className="fixed z-50 w-[172px] overflow-hidden rounded-xl border border-cw-border bg-white p-1.5 shadow-[0_12px_32px_rgba(0,0,0,0.12)]"
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => pick(onEdit)}
            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[12px] font-medium text-cw-text hover:bg-[#fff8e9]"
          >
            <Icon src="/icons/edit.svg" size={14} />
            Edit details
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => pick(onDelete)}
            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[12px] font-medium text-[#b25959] hover:bg-[#fbf3f3]"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M2.5 4.5h11M6 4.5V3a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1.5M4 4.5l.7 8.2a1 1 0 0 0 1 .9h4.6a1 1 0 0 0 1-.9l.7-8.2M6.5 7v4M9.5 7v4" />
            </svg>
            Delete
          </button>
        </div>
      )}
    </div>
  )
}

/**
 * Board setup — the same form creates a board (board = null) and edits one.
 * Name, the project folder the agents work in, which agents take part and on which CLI.
 */
function BoardEditModal({
  board,
  members,
  onClose,
  onSaved,
}: {
  board: Board | null
  members: Member[]
  onClose: () => void
  onSaved: (board: Board) => void
}) {
  const creating = board === null
  const agents = members.filter((m) => m.kind === "agent" && !m.archived)
  const [name, setName] = useState(board?.name ?? "")
  const [repoPath, setRepoPath] = useState(board?.repoPath ?? "")
  const [memberIds, setMemberIds] = useState<string[]>(board?.memberIds ?? agents.map((a) => a.id))
  const [checkCommand, setCheckCommand] = useState(board?.checkCommand ?? "")
  const [starterCard, setStarterCard] = useState(true)
  const [repo, setRepo] = useState<RepoCheck | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const agentsOn = memberIds.some((id) => agents.some((a) => a.id === id))
  const folder = repoPath.trim()
  // Agents need a folder to work in; a board without agents is just a board.
  const folderOk = !agentsOn || (folder.length > 0 && repo?.path === folder && repo.exists)
  const canSave = name.trim().length > 0 && folderOk && !busy

  // Ask the server what the folder looks like, a moment after typing stops.
  useEffect(() => {
    if (!folder) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reset for an empty field
      setRepo(null)
      return
    }
    let cancelled = false
    const timer = setTimeout(() => {
      api
        .checkRepo(folder)
        .then((result) => {
          if (!cancelled) setRepo({ ...result, path: folder })
        })
        .catch(() => {
          if (!cancelled) setRepo({ path: folder, exists: false, isGit: false, hasAgentNotes: false })
        })
    }, 350)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [folder])

  const toggleMember = (id: string) => {
    setMemberIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
  }

  const coderOn = agents.some((a) => a.agentRole === "coder" && memberIds.includes(a.id))
  const offerStarter = creating && coderOn && !!repo && repo.path === folder && repo.exists && !repo.hasAgentNotes

  const submit = async () => {
    if (!canSave) return
    setBusy(true)
    setError(null)
    try {
      if (board) {
        onSaved(
          await api.updateBoard(board.id, { name: name.trim(), repoPath: folder, memberIds, checkCommand: checkCommand.trim() })
        )
      } else {
        onSaved(
          await api.createBoard({
            name: name.trim(),
            repoPath: folder,
            memberIds,
            checkCommand: checkCommand.trim(),
            starterCard: starterCard && offerStarter,
          })
        )
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the board")
      setBusy(false)
    }
  }

  const folderStatus = !folder
    ? null
    : !repo || repo.path !== folder
      ? { tone: "muted", text: "Checking…" }
      : !repo.exists
        ? { tone: "bad", text: "Folder not found — use an absolute path (or ~/…)" }
        : !repo.isGit
          ? { tone: "warn", text: "Folder found, but it is not a git repository — the Coder commits its work, so run git init there first" }
          : repo.hasAgentNotes
            ? { tone: "good", text: "Git repository with CLAUDE.md / AGENTS.md — the agents will read it" }
            : { tone: "good", text: "Git repository. No CLAUDE.md yet — see below" }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-[4px]"
      role="dialog"
      aria-modal="true"
      aria-labelledby="board-edit-title"
      onClick={onClose}
    >
      <div
        className="cw-modal-shadow flex w-[480px] max-w-[calc(100vw-32px)] flex-col overflow-hidden rounded-xl border border-cw-border bg-white"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-cw-border py-4 pl-5 pr-4">
          <h2 id="board-edit-title" className="text-lg font-bold text-cw-text">
            {creating ? "New board" : "Board details"}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="flex size-7 items-center justify-center rounded-md border border-cw-border bg-cw-bg text-base font-bold text-cw-secondary hover:bg-[#eceae6]"
            aria-label="Close"
          >
            ×
          </button>
        </div>
        <form
          className="flex flex-col gap-4 p-5"
          onSubmit={(event) => {
            event.preventDefault()
            void submit()
          }}
        >
          <label className="flex w-full flex-col gap-1.5">
            <span className="text-xs font-semibold text-cw-secondary">Board name</span>
            <input
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              className={inputClass}
              placeholder="e.g. Merge game UI"
            />
          </label>
          <label className="flex w-full flex-col gap-1.5">
            <span className="text-xs font-semibold text-cw-secondary">Project folder</span>
            <input
              value={repoPath}
              onChange={(event) => setRepoPath(event.target.value)}
              className={inputClass}
              placeholder="/Users/you/Projects/my-app"
              spellCheck={false}
            />
            <span
              className={cn(
                "text-[11px] leading-[1.4]",
                !folderStatus && "text-cw-placeholder",
                folderStatus?.tone === "muted" && "text-cw-placeholder",
                folderStatus?.tone === "good" && "text-[#3f7d4e]",
                folderStatus?.tone === "warn" && "text-[#a06a00]",
                folderStatus?.tone === "bad" && "text-[#b25959]"
              )}
            >
              {folderStatus?.text ??
                (agentsOn
                  ? "Where the Coder works and the Architect reads — the folder with the code, on this computer."
                  : "Optional without agents.")}
            </span>
          </label>
          <label className="flex w-full flex-col gap-1.5">
            <span className="text-xs font-semibold text-cw-secondary">Check before Review</span>
            <input
              value={checkCommand}
              onChange={(event) => setCheckCommand(event.target.value)}
              className={cn(inputClass, "cw-mono text-[12px]")}
              placeholder="npm run typecheck && npm run lint"
              spellCheck={false}
            />
            <span className="text-[11px] leading-[1.4] text-cw-placeholder">
              Runs in the project folder after a coder hands a card to Review. If it fails, the card stays in In
              progress with the output in its chat and the coder gets one retry. Empty = no check.
            </span>
          </label>
          <div className="flex w-full flex-col gap-1.5">
            <span className="text-xs font-semibold text-cw-secondary">Agents on this board</span>
            <div className="flex flex-col gap-2 rounded-lg border border-cw-border bg-white px-3 py-2.5">
              {agents.map((agent) => {
                const on = memberIds.includes(agent.id)
                return (
                  <label key={agent.id} className="flex min-w-0 cursor-pointer items-center gap-2.5">
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={() => toggleMember(agent.id)}
                      className="size-4 accent-[#f2a000]"
                    />
                    <Avatar initials={agent.initials} tone={agent.tone} size={22} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] text-cw-text">
                        {agent.name} <span className="text-cw-placeholder">@{agent.handle}</span>
                      </span>
                      <span className="block truncate text-[11px] text-cw-placeholder">
                        {agent.agentRole === "coder" ? "coder" : "architect"} · {agentConfigLabel(agent)}
                        {agent.agent?.description ? ` — ${agent.agent.description}` : ""}
                      </span>
                    </span>
                  </label>
                )
              })}
              {agents.length === 0 && (
                <span className="text-[12px] text-cw-placeholder">No agents yet — add them under Agents in the sidebar.</span>
              )}
            </div>
            <span className="text-[11px] leading-[1.4] text-cw-placeholder">
              Unchecked agents ignore this board: no @mentions, no column triggers. With an Architect on the
              board, cards entering Ready are dispatched by it; the first coder in this list takes untagged cards.
            </span>
          </div>
          {offerStarter && (
            <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-cw-border bg-cw-warm/40 px-3 py-2.5">
              <input
                type="checkbox"
                checked={starterCard}
                onChange={(event) => setStarterCard(event.target.checked)}
                className="mt-0.5 size-4 accent-[#f2a000]"
              />
              <span className="min-w-0">
                <span className="block text-[13px] text-cw-text">Let the Coder describe the project first</span>
                <span className="block text-[11px] leading-[1.4] text-cw-placeholder">
                  Adds a Ready card: the Coder reads the code and writes CLAUDE.md (stack, structure, how to run and
                  check). Both agents read it on every run after that. Starts right away and spends one run.
                </span>
              </span>
            </label>
          )}
          {error && <p className="text-[12px] font-medium text-[#b25959]">{error}</p>}
        </form>
        <div className="flex items-center justify-end gap-2 border-t border-cw-border px-5 py-4">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-cw-border bg-white px-4 py-2.5 text-[13px] font-bold text-cw-text hover:bg-[#faf9f7]"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!canSave}
            onClick={() => void submit()}
            className="rounded-md bg-cw-accent px-4 py-2.5 text-[13px] font-bold text-white hover:bg-[#d99c1c] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? (creating ? "Creating…" : "Saving…") : creating ? "Create board" : "Save changes"}
          </button>
        </div>
      </div>
    </div>
  )
}

function ConfirmDialog({
  title,
  text,
  confirmLabel,
  busy = false,
  error,
  tone = "danger",
  alternative,
  onCancel,
  onConfirm,
}: {
  title: string
  text: string
  confirmLabel: string
  busy?: boolean
  error?: string | null
  tone?: "danger" | "accent"
  /** A second, non-destructive way out, shown between Cancel and the confirm button. */
  alternative?: { label: string; onClick: () => void }
  onCancel: () => void
  onConfirm: () => void
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-[4px]"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="confirm-title"
      onClick={onCancel}
    >
      <div
        className="cw-modal-shadow flex w-[420px] max-w-[calc(100vw-32px)] flex-col overflow-hidden rounded-xl border border-cw-border bg-white"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex flex-col gap-2 p-5">
          <h2 id="confirm-title" className="text-lg font-bold text-cw-text">
            {title}
          </h2>
          <p className="text-[13px] leading-[1.45] text-cw-secondary">{text}</p>
          {error && <p className="text-[12px] font-medium text-[#b25959]">{error}</p>}
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-cw-border px-5 py-4">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md border border-cw-border bg-white px-4 py-2.5 text-[13px] font-bold text-cw-text hover:bg-[#faf9f7]"
          >
            Cancel
          </button>
          {alternative && (
            <button
              type="button"
              disabled={busy}
              onClick={alternative.onClick}
              className="rounded-md bg-cw-accent px-4 py-2.5 text-[13px] font-bold text-white hover:bg-[#d99c1c] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {alternative.label}
            </button>
          )}
          <button
            type="button"
            autoFocus
            disabled={busy}
            onClick={onConfirm}
            className={cn(
              "rounded-md px-4 py-2.5 text-[13px] font-bold text-white disabled:cursor-not-allowed disabled:opacity-50",
              tone === "danger" ? "bg-[#b25959] hover:bg-[#9d4b4b]" : "bg-cw-accent hover:bg-[#d99c1c]"
            )}
          >
            {busy ? "Working…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

function TaskCardContent({
  card,
  byId,
  dragging = false,
}: {
  card: CardView
  byId: Map<string, Member>
  dragging?: boolean
}) {
  const showComments = card.commentCount > 0
  const showAttachments = card.attachments > 0
  const hasStats = showComments || showAttachments

  return (
    <div
      className={cn(
        "cw-card-shadow flex w-full flex-col gap-[9px] rounded-[10px] border-2 p-[14px] text-left",
        card.selected ? "border-[#ed9e1c] bg-cw-active-card" : "border-cw-border bg-white",
        dragging && "shadow-[0_8px_24px_rgba(0,0,0,0.12)]"
      )}
    >
      <h3 className="w-full text-sm font-semibold text-cw-text">{card.title}</h3>
      {card.description && (
        <p className="cw-line-clamp-2 w-full text-xs leading-[1.3] text-[#6e6e69]">{stripImages(card.description)}</p>
      )}
      <div className="flex w-full items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <PriorityPill priority={card.priority} />
          <AgentBadge card={card} byId={byId} />
          {card.waitingFor.length > 0 && !card.agentStatus && (
            <span
              className="inline-flex h-[22px] min-w-0 items-center gap-1 whitespace-nowrap rounded-full bg-cw-bg px-2 text-[9px] font-semibold leading-none text-cw-secondary"
              title={`Waits for: ${card.waitingFor.join(", ")}`}
            >
              <span className="truncate">after “{card.waitingFor[0]}”{card.waitingFor.length > 1 ? ` +${card.waitingFor.length - 1}` : ""}</span>
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {hasStats && (
            <>
              {showComments && (
                <span className="flex h-[22px] items-center gap-[3px] text-[11px] font-medium leading-none text-[#666]">
                  <Icon src="/icons/comment.svg" size={13} />
                  {card.commentCount}
                </span>
              )}
              {showComments && showAttachments && <span className="h-3 w-px bg-[#d1d1d1]" />}
              {showAttachments && (
                <span className="flex h-[22px] items-center gap-[3px] text-[11px] font-medium leading-none text-[#666]">
                  <Icon src="/icons/paperclip.svg" size={13} />
                  {card.attachments}
                </span>
              )}
              {card.assignees.length > 0 && <span className="h-3 w-px bg-[#d1d1d1]" />}
            </>
          )}
          <div className="flex items-center">
            {card.assignees.map((person, index) => (
              <span
                key={`${card.id}-${person.id}`}
                className={cn("flex", index < card.assignees.length - 1 && "-mr-[5px]")}
              >
                <Avatar initials={person.initials} tone={person.tone} title={person.name} />
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

function StaticTaskCard({
  card,
  byId,
  onSelect,
}: {
  card: CardView
  byId: Map<string, Member>
  onSelect: (id: string) => void
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(card.id)}
      className="w-full cursor-grab touch-none text-left active:cursor-grabbing hover:shadow-[0_4px_14px_rgba(0,0,0,0.08)]"
    >
      <TaskCardContent card={card} byId={byId} />
    </button>
  )
}

function SortableTaskCard({
  card,
  byId,
  onSelect,
}: {
  card: CardView
  byId: Map<string, Member>
  onSelect: (id: string) => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: card.id,
  })

  return (
    <button
      ref={setNodeRef}
      type="button"
      style={{ transform: CSS.Transform.toString(transform), transition }}
      {...attributes}
      {...listeners}
      onClick={() => onSelect(card.id)}
      className={cn(
        "w-full cursor-grab touch-none text-left active:cursor-grabbing",
        "hover:shadow-[0_4px_14px_rgba(0,0,0,0.08)]",
        isDragging && "z-10 opacity-40"
      )}
    >
      <TaskCardContent card={card} byId={byId} />
    </button>
  )
}

type ColumnProps = {
  column: ColumnView
  columnIndex: number
  columnCount: number
  byId: Map<string, Member>
  onSelectCard: (id: string) => void
  onAddCard: (columnId: string) => void
  onRenameColumn: (columnId: string, title: string) => Promise<void>
  onDeleteColumn: (columnId: string) => Promise<void>
  onArchiveColumn: (column: ColumnView) => void
}

function columnClass(columnIndex: number) {
  return cn(
    "relative flex min-h-0 min-w-0 flex-col",
    // Fixed width, never stretched: a list is the same size whether or not the
    // task panel is open.
    "w-[300px] shrink-0",
    columnIndex > 0 && "border-l border-[#d9d9d7] pl-4",
    "pr-4"
  )
}

function ColumnHeader({
  column,
  onRename,
  onDelete,
  onArchiveAll,
  handleProps,
}: {
  column: ColumnView
  onRename: (title: string) => Promise<void>
  onDelete: () => Promise<void>
  onArchiveAll: () => void
  /** Drag-handle listeners: the header is where a list is picked up. */
  handleProps?: React.HTMLAttributes<HTMLDivElement>
}) {
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(column.title)
  const [error, setError] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const open = menuPos != null

  useEffect(() => {
    if (!open) return
    const close = () => setMenuPos(null)
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) close()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close()
    }
    document.addEventListener("mousedown", onPointerDown)
    document.addEventListener("keydown", onKeyDown)
    window.addEventListener("resize", close)
    return () => {
      document.removeEventListener("mousedown", onPointerDown)
      document.removeEventListener("keydown", onKeyDown)
      window.removeEventListener("resize", close)
    }
  }, [open])

  const toggle = () => {
    if (menuPos) {
      setMenuPos(null)
      return
    }
    const rect = triggerRef.current?.getBoundingClientRect()
    if (!rect) return
    setMenuPos({ top: rect.bottom + 4, left: Math.max(8, rect.right - 172) })
  }

  const startRename = () => {
    setMenuPos(null)
    setDraft(column.title)
    setError(null)
    setEditing(true)
  }

  const commitRename = async () => {
    const title = draft.trim()
    setEditing(false)
    if (!title || title === column.title) return
    try {
      await onRename(title)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not rename")
    }
  }

  const remove = async () => {
    setMenuPos(null)
    setError(null)
    try {
      await onDelete()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete")
    }
  }

  return (
    <div
      ref={rootRef}
      {...(handleProps && !editing ? { ...handleProps, "data-column-handle": "" } : {})}
      className={cn(
        "group/col mb-2.5 shrink-0 select-none",
        handleProps && !editing && "cursor-grab touch-none active:cursor-grabbing"
      )}
    >
      <div className="flex items-start justify-between gap-2">
        {editing ? (
          <input
            autoFocus
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={() => void commitRename()}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault()
                void commitRename()
              } else if (event.key === "Escape") {
                event.preventDefault()
                setEditing(false)
              }
            }}
            className="-ml-1 min-w-0 flex-1 rounded-md border border-cw-accent bg-white px-1 text-lg font-bold text-cw-text outline-none"
          />
        ) : (
          <h2 className="min-w-0 flex-1 truncate text-lg font-bold text-cw-text">{column.title}</h2>
        )}
        <div className="flex shrink-0 items-center gap-1">
          <span className="text-xs text-cw-placeholder">{column.cards.length}</span>
          {!editing && (
            <button
              ref={triggerRef}
              type="button"
              aria-label={`List menu: ${column.title}`}
              aria-haspopup="menu"
              aria-expanded={open}
              onClick={toggle}
              className={cn(
                "flex size-6 items-center justify-center rounded-md text-cw-secondary transition-colors hover:bg-[#eceae6] hover:text-cw-text",
                open && "bg-[#eceae6]"
              )}
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true">
                <circle cx="7" cy="2.5" r="1.4" />
                <circle cx="7" cy="7" r="1.4" />
                <circle cx="7" cy="11.5" r="1.4" />
              </svg>
            </button>
          )}
        </div>
      </div>
      {error && <p className="mt-1 text-[11px] font-medium text-[#b25959]">{error}</p>}

      {menuPos && (
        <div
          role="menu"
          style={{ top: menuPos.top, left: menuPos.left }}
          className="fixed z-50 w-[172px] overflow-hidden rounded-xl border border-cw-border bg-white p-1.5 shadow-[0_12px_32px_rgba(0,0,0,0.12)]"
        >
          <button
            type="button"
            role="menuitem"
            onClick={startRename}
            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[12px] font-medium text-cw-text hover:bg-[#fff8e9]"
          >
            <Icon src="/icons/edit.svg" size={14} />
            Rename
          </button>
          {column.cards.length > 0 && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setMenuPos(null)
                onArchiveAll()
              }}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[12px] font-medium text-cw-text hover:bg-[#fff8e9]"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M2 3.5h12v3H2zM3 6.5v6a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-6M6.5 9.5h3" />
              </svg>
              Archive all cards
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            onClick={() => void remove()}
            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[12px] font-medium text-[#b25959] hover:bg-[#fbf3f3]"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M2.5 4.5h11M6 4.5V3a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1.5M4 4.5l.7 8.2a1 1 0 0 0 1 .9h4.6a1 1 0 0 0 1-.9l.7-8.2M6.5 7v4M9.5 7v4" />
            </svg>
            Delete list
          </button>
        </div>
      )}
    </div>
  )
}

/** Trello-style "Add another list" slot after the last column. */
function AddListSlot({ onAdd }: { onAdd: (title: string) => Promise<void> }) {
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async () => {
    const value = title.trim()
    if (!value || busy) return
    setBusy(true)
    setError(null)
    try {
      await onAdd(value)
      setTitle("")
      setEditing(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add the list")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex w-[300px] shrink-0 flex-col border-x border-[#d9d9d7] px-4">
      {editing ? (
        <form
          className="flex w-[240px] flex-col gap-2 rounded-[10px] border border-cw-border bg-white p-2"
          onSubmit={(event) => {
            event.preventDefault()
            void submit()
          }}
        >
          <input
            autoFocus
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault()
                setEditing(false)
                setTitle("")
              }
            }}
            placeholder="Enter list name…"
            className="w-full rounded-md border border-cw-accent bg-white px-2.5 py-2 text-[13px] font-semibold text-cw-text placeholder:font-normal placeholder:text-cw-placeholder outline-none"
          />
          {error && <p className="text-[11px] font-medium text-[#b25959]">{error}</p>}
          <div className="flex items-center gap-2">
            <button
              type="submit"
              disabled={!title.trim() || busy}
              className="rounded-md bg-cw-accent px-3 py-1.5 text-[12px] font-bold text-white hover:bg-[#d99c1c] disabled:cursor-not-allowed disabled:opacity-50"
            >
              Add list
            </button>
            <button
              type="button"
              onClick={() => {
                setEditing(false)
                setTitle("")
              }}
              className="flex size-7 items-center justify-center rounded-md text-base font-bold text-cw-secondary hover:bg-[#eceae6]"
              aria-label="Cancel"
            >
              ×
            </button>
          </div>
        </form>
      ) : (
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="flex h-10 w-[240px] items-center gap-2 rounded-[10px] bg-[#e9e8e4] px-3.5 text-[13px] font-semibold text-cw-text hover:bg-[#e1dfda]"
        >
          <Icon src="/icons/plus.svg" size={12} />
          Add another list
        </button>
      )}
    </div>
  )
}

function AddCardButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-1.5 pl-[5px] text-xs font-semibold text-cw-text hover:text-cw-accent-strong"
    >
      <Icon src="/icons/plus.svg" size={12} />
      Add a card
    </button>
  )
}

function StaticKanbanColumn({
  column,
  columnIndex,
  columnCount,
  byId,
  onSelectCard,
  onAddCard,
  onRenameColumn,
  onDeleteColumn,
  onArchiveColumn,
}: ColumnProps) {
  return (
    <div className={columnClass(columnIndex)}>
      <ColumnHeader
        column={column}
        onRename={(title) => onRenameColumn(column.id, title)}
        onDelete={() => onDeleteColumn(column.id)}
        onArchiveAll={() => onArchiveColumn(column)}
      />
      <div className="cw-scrollbar flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto rounded-lg pb-16">
        {column.cards.map((card) => (
          <StaticTaskCard key={card.id} card={card} byId={byId} onSelect={onSelectCard} />
        ))}
        {column.role !== "done" && <AddCardButton onClick={() => onAddCard(column.id)} />}
      </div>
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-20 bg-gradient-to-b from-transparent to-cw-bg" />
    </div>
  )
}

function SortableKanbanColumn({
  column,
  columnIndex,
  columnCount,
  byId,
  onSelectCard,
  onAddCard,
  onRenameColumn,
  onDeleteColumn,
  onArchiveColumn,
}: ColumnProps) {
  const { setNodeRef, isOver } = useDroppable({ id: column.id })
  const {
    attributes,
    listeners,
    setNodeRef: setColumnRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: COLUMN_DRAG_PREFIX + column.id, data: { type: "column" } })
  const cardIds = useMemo(() => column.cards.map((card) => card.id), [column.cards])

  return (
    <div
      ref={setColumnRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(columnClass(columnIndex), "bg-cw-bg", isDragging && "z-20 opacity-60")}
    >
      <ColumnHeader
        column={column}
        onRename={(title) => onRenameColumn(column.id, title)}
        onDelete={() => onDeleteColumn(column.id)}
        onArchiveAll={() => onArchiveColumn(column)}
        handleProps={{ ...attributes, ...listeners }}
      />
      <div
        ref={setNodeRef}
        className={cn(
          "cw-scrollbar flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto rounded-lg pb-16 transition-colors",
          isOver && "bg-[#f3f1ec]/60"
        )}
      >
        <SortableContext items={cardIds} strategy={verticalListSortingStrategy}>
          {column.cards.map((card) => (
            <SortableTaskCard key={card.id} card={card} byId={byId} onSelect={onSelectCard} />
          ))}
        </SortableContext>
        {column.role !== "done" && <AddCardButton onClick={() => onAddCard(column.id)} />}
      </div>
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-20 bg-gradient-to-b from-transparent to-cw-bg" />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Create / edit task modal — writes through the API


function TaskModal({
  state: modal,
  board,
  members,
  onClose,
  onTaskSaved,
  onTaskDeleted,
  onCreateBoard,
}: {
  state: ModalState
  board: Board
  members: Member[]
  onClose: () => void
  onTaskSaved: (task: Task) => void
  onTaskDeleted: (taskId: string) => void
  /** "Board" in the type switch: close this dialog and open the board setup instead. */
  onCreateBoard: () => void
}) {
  const editing = modal.mode === "edit" ? modal.task : null
  const [title, setTitle] = useState(editing?.title ?? "")
  const [description, setDescription] = useState(editing?.description ?? "")
  const [priority, setPriority] = useState<Priority>(editing?.priority ?? "MEDIUM")
  const [columnId, setColumnId] = useState(
    editing?.columnId ?? (modal.mode === "create" ? modal.columnId : undefined) ?? board.columns[0]?.id ?? ""
  )
  const [assigneeIds, setAssigneeIds] = useState<string[]>(editing?.assigneeIds ?? [])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const boardMembers = useMemo(
    () => board.memberIds.map((id) => members.find((m) => m.id === id)).filter((m): m is Member => !!m),
    [board.memberIds, members]
  )

  const toggleAssignee = (id: string) => {
    setAssigneeIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
  }

  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      if (editing) {
        const saved = await api.updateTask(editing.id, {
          title,
          description,
          priority,
          assigneeIds,
          ...(columnId !== editing.columnId ? { columnId } : {}),
        })
        onTaskSaved(saved)
      } else {
        const created = await api.createTask({
          boardId: board.id,
          columnId,
          title,
          description,
          priority,
          assigneeIds,
        })
        onTaskSaved(created)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong")
    } finally {
      setBusy(false)
    }
  }

  const archive = async () => {
    if (!editing) return
    setBusy(true)
    try {
      await api.updateTask(editing.id, { archived: true })
      onTaskDeleted(editing.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not archive")
      setBusy(false)
    }
  }

  const remove = async () => {
    if (!editing) return
    if (!confirmDelete) {
      setConfirmDelete(true)
      return
    }
    setBusy(true)
    try {
      await api.deleteTask(editing.id)
      onTaskDeleted(editing.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete")
      setBusy(false)
    }
  }

  const canSubmit = title.trim().length > 0

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-[4px]"
      role="dialog"
      aria-modal="true"
      aria-labelledby="create-task-title"
      onClick={onClose}
    >
      <div
        className="cw-modal-shadow flex max-h-[calc(100vh-32px)] w-[480px] max-w-[calc(100vw-32px)] flex-col overflow-hidden rounded-xl border border-cw-border bg-white"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-cw-border py-4 pl-5 pr-4">
          <h2 id="create-task-title" className="text-lg font-bold text-cw-text">
            {editing ? "Edit task" : "Create new task"}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="flex size-7 items-center justify-center rounded-md border border-cw-border bg-cw-bg text-base font-bold text-cw-secondary hover:bg-[#eceae6]"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <form
          className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-5"
          onSubmit={(event) => {
            event.preventDefault()
            if (canSubmit && !busy) void submit()
          }}
        >
          {!editing && (
            <div className="flex gap-1">
              {(["task", "board"] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => (option === "board" ? onCreateBoard() : undefined)}
                  className={cn(
                    "flex flex-1 items-center justify-center rounded-lg border px-3 py-2.5 text-[13px]",
                    option === "task"
                      ? "border-cw-accent bg-cw-warm font-bold text-cw-accent"
                      : "border-cw-border bg-white font-semibold text-cw-secondary hover:bg-[#faf9f7]"
                  )}
                >
                  {option === "task" ? "Task" : "Board"}
                </button>
              ))}
            </div>
          )}

          <label className="flex w-full flex-col gap-1.5">
                <span className="text-xs font-semibold text-cw-secondary">Task title</span>
                <input
                  autoFocus
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  className={inputClass}
                  placeholder="Enter task title"
                />
              </label>

              <label className="flex w-full flex-col gap-1.5">
                <span className="text-xs font-semibold text-cw-secondary">Description</span>
                <textarea
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  onPaste={(event) => handleImagePaste(event, setDescription, setError)}
                  className={cn(inputClass, "h-24 resize-none leading-[1.4]")}
                  placeholder="Add a brief description of the task..."
                />
              </label>

              <label className="flex w-full flex-col gap-1.5">
                <span className="text-xs font-semibold text-cw-secondary">Priority</span>
                <div className="relative">
                  <select
                    value={priority}
                    onChange={(event) => setPriority(event.target.value as Priority)}
                    className={cn(inputClass, "appearance-none pr-10")}
                  >
                    {PRIORITIES.map((option) => (
                      <option key={option} value={option}>
                        {option.charAt(0) + option.slice(1).toLowerCase()}
                      </option>
                    ))}
                  </select>
                  <Icon
                    src="/icons/chevron-down.svg"
                    size={16}
                    className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2"
                  />
                </div>
              </label>

              <label className="flex w-full flex-col gap-1.5">
                <span className="text-xs font-semibold text-cw-secondary">Status / Column</span>
                <div className="relative">
                  <select
                    value={columnId}
                    onChange={(event) => setColumnId(event.target.value)}
                    className={cn(inputClass, "appearance-none pr-10")}
                  >
                    {board.columns.map((column) => (
                      <option key={column.id} value={column.id}>
                        {column.title}
                      </option>
                    ))}
                  </select>
                  <Icon
                    src="/icons/chevron-down.svg"
                    size={16}
                    className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2"
                  />
                </div>
              </label>

              <div className="flex w-full flex-col gap-1.5">
                <span className="text-xs font-semibold text-cw-secondary">Assignees</span>
                <div className="flex flex-wrap items-center gap-2 rounded-lg border border-cw-border bg-white px-3 py-2.5">
                  {boardMembers.map((member) => {
                    const selected = assigneeIds.includes(member.id)
                    return (
                      <button
                        key={member.id}
                        type="button"
                        onClick={() => toggleAssignee(member.id)}
                        title={member.name}
                        className={cn(
                          "flex items-center gap-1.5 rounded-full border py-0.5 pl-0.5 pr-2.5 text-[11px] font-semibold",
                          selected
                            ? "border-cw-accent bg-cw-warm text-cw-text"
                            : "border-transparent text-cw-secondary opacity-60 hover:opacity-100"
                        )}
                      >
                        <Avatar initials={member.initials} tone={member.tone} size={22} />
                        {shortName(member)}
                      </button>
                    )
                  })}
                  {boardMembers.length === 0 && (
                    <span className="text-[13px] text-cw-placeholder">No members on this board</span>
                  )}
                </div>
              </div>

          {error && <p className="text-[12px] font-medium text-[#b25959]">{error}</p>}
        </form>

        <div className="flex items-center justify-between gap-2 border-t border-cw-border px-5 py-4">
          <button
            type="button"
            disabled={!editing || busy}
            onClick={remove}
            className={cn(
              "rounded-md border px-4 py-2.5 text-[13px] font-bold",
              editing
                ? confirmDelete
                  ? "border-[#b25959] bg-[#b25959] text-white hover:bg-[#9d4b4b]"
                  : "border-[#e3e0de] text-[#b25959] hover:bg-[#fbf3f3]"
                : "border-[#e3e0de] text-[#b25959] opacity-50"
            )}
          >
            {confirmDelete ? "Confirm delete" : "Delete"}
          </button>
          {editing && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void archive()}
              className="mr-auto rounded-md border border-cw-border bg-white px-4 py-2.5 text-[13px] font-bold text-cw-secondary hover:bg-[#faf9f7]"
            >
              Archive
            </button>
          )}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-cw-border bg-white px-4 py-2.5 text-[13px] font-bold text-cw-text hover:bg-[#faf9f7]"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={!canSubmit || busy}
              onClick={() => void submit()}
              className="rounded-md bg-cw-accent px-4 py-2.5 text-[13px] font-bold text-white hover:bg-[#d99c1c] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? "Saving…" : editing ? "Save changes" : "Create task"}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Agent runs block in the task panel

const RUN_STATUS_STYLE: Record<Run["status"], { bg: string; text: string }> = {
  queued: { bg: "#f6f6f5", text: "#706e69" },
  running: { bg: "#fff3da", text: "#f2a000" },
  done: { bg: "#ddf9e9", text: "#48c77c" },
  failed: { bg: "#fbe9e9", text: "#b25959" },
  cancelled: { bg: "#f6f6f5", text: "#a4a19a" },
}

function triggerLabel(trigger: string): string {
  if (trigger.startsWith("mention:")) return "mention"
  if (trigger === "column:in_progress") return "in progress"
  if (trigger === "column:review") return "review"
  if (trigger === "dispatch") return "dispatch"
  return trigger
}

function RunsBlock({ runs, byId }: { runs: Run[]; byId: Map<string, Member> }) {
  const [open, setOpen] = useState(false)
  if (runs.length === 0) return null
  const active = runs.filter((run) => run.status === "queued" || run.status === "running").length
  return (
    <div className="shrink-0 border-b border-cw-border px-4 py-3">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center justify-between text-left"
      >
        <span className="text-[13px] font-bold text-cw-text">Agent runs</span>
        <span className="text-[10px] text-cw-secondary">
          {runs.length}
          {active > 0 ? ` · ${active} active` : ""} {open ? "▴" : "▾"}
        </span>
      </button>
      {open && (
        <ul className="mt-2 flex max-h-56 flex-col gap-2 overflow-y-auto">
          {runs.map((run) => {
            const agent = byId.get(run.agentId)
            const style = RUN_STATUS_STYLE[run.status]
            return (
              <li key={run.id} className="rounded-md border border-cw-border px-2.5 py-2">
                <div className="flex items-center gap-1.5">
                  {agent && <Avatar initials={agent.initials} tone={agent.tone} size={18} title={agent.name} />}
                  <span className="min-w-0 flex-1 truncate text-[11px] font-semibold text-cw-text">
                    {shortName(agent)} · {triggerLabel(run.trigger)}
                  </span>
                  <span
                    className="rounded-full px-2 py-[2px] text-[9px] font-bold uppercase"
                    style={{ backgroundColor: style.bg, color: style.text }}
                  >
                    {run.status}
                  </span>
                </div>
                <p className="mt-1 text-[9px] text-cw-placeholder">
                  {formatTime(run.startedAt ?? run.createdAt)}
                  {run.finishedAt ? ` → ${formatTime(run.finishedAt)}` : ""}
                </p>
                {run.summary && (
                  <p className="mt-1 text-[11px] leading-[1.35] text-cw-secondary">{run.summary}</p>
                )}
                {run.log && (
                  <details className="mt-1">
                    <summary className="cursor-pointer text-[10px] font-semibold text-cw-secondary">Log</summary>
                    <pre className="cw-mono mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-cw-bg p-2 text-[10px] leading-[1.35] text-cw-text">
                      {run.log}
                    </pre>
                  </details>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Archive view — the archived cards of a board as one list; each card can be
// opened in the task panel, restored to its list or deleted for good.

function ArchiveView({
  cards,
  byId,
  loading,
  error,
  busyId,
  onSelect,
  onRestore,
  onDelete,
}: {
  cards: CardView[]
  byId: Map<string, Member>
  loading: boolean
  error: string | null
  busyId: string | null
  onSelect: (id: string) => void
  onRestore: (card: CardView) => void
  onDelete: (card: CardView) => void
}) {
  return (
    <div className="cw-hscroll flex min-w-0 flex-1 gap-0 overflow-x-auto overflow-y-hidden bg-cw-bg p-[18px]">
      <div className={cn(columnClass(0), "border-r border-[#d9d9d7]")}>
        <div className="mb-2.5 flex shrink-0 items-start justify-between gap-2">
          <h2 className="min-w-0 flex-1 truncate text-lg font-bold text-cw-text">Archive</h2>
          <span className="text-xs text-cw-placeholder">{cards.length}</span>
        </div>
        <div className="cw-scrollbar flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto rounded-lg pb-16">
          {error && <p className="text-[11px] font-medium text-[#b25959]">{error}</p>}
          {loading ? (
            <p className="text-[12px] text-cw-placeholder">Loading…</p>
          ) : cards.length === 0 ? (
            <p className="text-[12px] text-cw-placeholder">Nothing archived on this board.</p>
          ) : (
            cards.map((card) => (
              <div key={card.id} className="flex shrink-0 flex-col gap-[4px]">
                <button
                  type="button"
                  onClick={() => onSelect(card.id)}
                  className="w-full text-left hover:shadow-[0_4px_14px_rgba(0,0,0,0.08)]"
                >
                  <TaskCardContent card={card} byId={byId} />
                </button>
                <div className="flex items-center gap-1.5 pl-[10px] text-xs font-semibold text-cw-text">
                  <button
                    type="button"
                    disabled={busyId === card.id}
                    onClick={() => onRestore(card)}
                    className="hover:text-cw-accent-strong disabled:opacity-50"
                  >
                    Restore
                  </button>
                  <span className="text-cw-placeholder">•</span>
                  <button
                    type="button"
                    disabled={busyId === card.id}
                    onClick={() => onDelete(card)}
                    className="hover:text-cw-accent-strong disabled:opacity-50"
                  >
                    Delete
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-20 bg-gradient-to-b from-transparent to-cw-bg" />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Agents — the workspace's agents and their configuration. Functional for now; the
// screen gets its own design later.

const ROLE_LABELS: Record<AgentRole, string> = { architect: "Architect", coder: "Coder" }

function workerLine(worker: WorkerStatus | null): { tone: "good" | "warn" | "bad"; text: string } {
  if (!worker || !worker.online) {
    return { tone: "bad", text: "Worker offline — nothing runs until you start it: npm run up (board + agents) or npm run worker:live" }
  }
  const engines = Object.entries(worker.engines)
  const missing = engines.filter(([, v]) => !v).map(([e]) => ENGINE_LABELS[e as AgentEngine] ?? e)
  const found = engines.filter(([, v]) => v).map(([e, v]) => `${ENGINE_LABELS[e as AgentEngine] ?? e} ${v}`)
  if (worker.mode === "stub") return { tone: "warn", text: "Worker online in stub mode — agents answer without a model (CS_AGENT_MODE=stub)" }
  if (missing.length > 0) {
    return { tone: "warn", text: `Worker online · ${found.join(" · ") || "no CLI found"} · missing: ${missing.join(", ")} — install and log in, the worker re-checks every minute` }
  }
  return { tone: "good", text: `Worker online · ${found.join(" · ") || "live"}` }
}

function WorkerPill({ worker, onClick }: { worker: WorkerStatus; onClick: () => void }) {
  const line = workerLine(worker)
  const label = !worker.online ? "Agents offline" : worker.mode === "stub" ? "Agents: stub" : "Agents online"
  return (
    <button
      type="button"
      onClick={onClick}
      title={line.text}
      className={cn(
        "flex h-9 items-center gap-1.5 rounded-md border px-2.5 text-[11px] font-semibold",
        line.tone === "good" && "border-[#cfe3d3] bg-[#f1f8f2] text-[#3f7d4e]",
        line.tone === "warn" && "border-[#ecdcb3] bg-[#fdf7e8] text-[#a06a00]",
        line.tone === "bad" && "border-cw-border bg-cw-bg text-cw-secondary"
      )}
    >
      <span
        className={cn("inline-block size-1.5 rounded-full", worker.online && line.tone === "good" && "cw-pulse")}
        style={{ backgroundColor: line.tone === "good" ? "#3f7d4e" : line.tone === "warn" ? "#d99c1c" : "#b5b3ae" }}
      />
      {label}
    </button>
  )
}

function StopRunButton({ runId, requested, onStopped }: { runId: number; requested: boolean; onStopped: () => void }) {
  const [busy, setBusy] = useState(false)
  const stop = async () => {
    setBusy(true)
    try {
      await api.cancelRun(runId)
      onStopped()
    } catch {
      // the run may have just finished; the next refetch shows it
    } finally {
      setBusy(false)
    }
  }
  return (
    <button
      type="button"
      disabled={busy || requested}
      onClick={() => void stop()}
      title={requested ? "Stopping — the worker kills the process on its next check" : "Stop this run; the card stays where it is"}
      className="flex h-[26px] items-center gap-1 rounded-full border border-[#e9c9c9] bg-[#fbf3f3] px-2.5 text-[10px] font-semibold text-[#b25959] hover:bg-[#f6e4e4] disabled:opacity-60"
    >
      <span className="inline-block size-2 rounded-[2px] bg-[#b25959]" />
      {requested ? "Stopping…" : "Stop"}
    </button>
  )
}

function AgentsView({
  agents,
  boards,
  worker,
  onEdit,
  onCreate,
}: {
  agents: Member[]
  boards: Board[]
  worker: WorkerStatus | null
  onEdit: (agent: Member) => void
  onCreate: () => void
}) {
  const boardsOf = (agent: Member) => boards.filter((b) => b.memberIds.includes(agent.id))
  const status = workerLine(worker)
  return (
    <div className="cw-scrollbar flex min-w-0 flex-1 flex-col overflow-y-auto bg-cw-bg p-[18px]">
      <div className="flex w-full max-w-[760px] flex-col gap-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-bold text-cw-text">Agents</h2>
            <p className="mt-1 text-[12px] leading-[1.45] text-cw-secondary">
              Each agent is a member with a role and its own engine, model, effort and instructions. Boards pick
              which agents take part. The Architect sorts every board’s Ready queue; coders take their cards one
              after another — one coder at a time per repository.
            </p>
          </div>
          <button
            type="button"
            onClick={onCreate}
            className="shrink-0 rounded-md bg-cw-accent px-4 py-2 text-[13px] font-bold text-white hover:bg-[#d99c1c]"
          >
            + New agent
          </button>
        </div>

        <p
          className={cn(
            "rounded-lg border px-3 py-2 text-[11px] leading-[1.45]",
            status.tone === "good" && "border-[#cfe3d3] bg-[#f1f8f2] text-[#3f7d4e]",
            status.tone === "warn" && "border-[#ecdcb3] bg-[#fdf7e8] text-[#a06a00]",
            status.tone === "bad" && "border-cw-border bg-white text-cw-secondary"
          )}
        >
          {status.text}
        </p>

        <div className="flex flex-col gap-2.5">
          {agents.length === 0 && (
            <p className="rounded-[10px] border-2 border-dashed border-cw-border p-5 text-center text-[12px] text-cw-placeholder">
              No agents yet. Create an Architect and at least one Coder, then add them to a board.
            </p>
          )}
          {agents.map((agent) => {
            const on = boardsOf(agent)
            return (
              <button
                key={agent.id}
                type="button"
                onClick={() => onEdit(agent)}
                className="cw-card-shadow flex w-full items-center gap-3.5 rounded-[10px] border-2 border-cw-border bg-white p-[14px] text-left hover:shadow-[0_4px_14px_rgba(0,0,0,0.08)]"
              >
                <Avatar initials={agent.initials} tone={agent.tone} size={36} />
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="truncate text-sm font-semibold text-cw-text">{agent.name}</span>
                    <span className="shrink-0 text-[11px] text-cw-placeholder">@{agent.handle}</span>
                    <span
                      className={cn(
                        "shrink-0 rounded-full px-2 py-0.5 text-[9px] font-semibold uppercase leading-none tracking-wide",
                        agent.agentRole === "architect" ? "bg-[#efe7fb] text-[#5b3d92]" : "bg-[#e3eefb] text-[#2c5a94]"
                      )}
                    >
                      {agent.agentRole ? ROLE_LABELS[agent.agentRole] : "agent"}
                    </span>
                  </div>
                  {agent.agent?.description && (
                    <span className="truncate text-xs text-[#6e6e69]">{agent.agent.description}</span>
                  )}
                  <span className="truncate text-[11px] text-cw-placeholder">
                    {agentConfigLabel(agent)}
                    {" · "}
                    {on.length === 0 ? "on no board" : `on ${on.map((b) => b.name).join(", ")}`}
                  </span>
                </div>
                <Icon src="/icons/edit.svg" size={14} className="opacity-60" />
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}

const MODEL_HINTS: Record<AgentEngine, string> = {
  claude: "opus, sonnet, haiku or a full model name — empty = the CLI's default",
  codex: "e.g. gpt-5-codex — empty = the CLI's default",
  stub: "ignored in stub mode",
}

function AgentEditModal({
  agent,
  worker,
  onClose,
  onSaved,
}: {
  agent: Member | null
  worker: WorkerStatus | null
  onClose: () => void
  onSaved: () => void
}) {
  const creating = agent === null
  const config = agent?.agent ?? null
  const [name, setName] = useState(agent?.name ?? "")
  const [handle, setHandle] = useState(agent?.handle ?? "")
  const [handleTouched, setHandleTouched] = useState(!creating)
  const [role, setRole] = useState<AgentRole>(agent?.agentRole ?? "coder")
  const [engine, setEngine] = useState<AgentEngine>(config?.engine ?? "claude")
  const [model, setModel] = useState(config?.model ?? "")
  const [effort, setEffort] = useState<AgentEffort | "">(config?.effort ?? "")
  const [maxTurns, setMaxTurns] = useState(config?.maxTurns ? String(config.maxTurns) : "")
  const [description, setDescription] = useState(config?.description ?? "")
  const [instructions, setInstructions] = useState(config?.instructions ?? "")
  const [tone, setTone] = useState<AvatarTone>(agent?.tone ?? "blue")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const engineMissing = !!worker && worker.online && worker.mode === "live" && engine in worker.engines && !worker.engines[engine]

  const canSave = name.trim().length > 0 && !busy

  const submit = async () => {
    if (!canSave) return
    setBusy(true)
    setError(null)
    const input: AgentInput = {
      name: name.trim(),
      handle: handle.trim() || undefined,
      role,
      engine,
      model: model.trim() || null,
      effort: effort || null,
      maxTurns: maxTurns.trim() ? Number(maxTurns) : null,
      description: description.trim(),
      instructions: instructions.trim(),
      tone,
    }
    try {
      if (agent) await api.updateAgent(agent.id, input)
      else await api.createAgent(input)
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the agent")
      setBusy(false)
    }
  }

  const remove = async () => {
    if (!agent) return
    setBusy(true)
    setError(null)
    try {
      await api.removeAgent(agent.id)
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not remove the agent")
      setBusy(false)
      setConfirmRemove(false)
    }
  }

  const selectClass =
    "w-full appearance-none rounded-lg border border-cw-border bg-white px-3 py-2.5 pr-9 text-[13px] text-cw-text outline-none focus:border-cw-accent"

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-[4px]"
      role="dialog"
      aria-modal="true"
      aria-labelledby="agent-edit-title"
      onClick={onClose}
    >
      <div
        className="cw-modal-shadow flex max-h-[min(760px,92vh)] w-[520px] max-w-[calc(100vw-32px)] flex-col overflow-hidden rounded-xl border border-cw-border bg-white"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-cw-border py-4 pl-5 pr-4">
          <h2 id="agent-edit-title" className="text-lg font-bold text-cw-text">
            {creating ? "New agent" : "Agent"}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="flex size-7 items-center justify-center rounded-md border border-cw-border bg-cw-bg text-base font-bold text-cw-secondary hover:bg-[#eceae6]"
            aria-label="Close"
          >
            ×
          </button>
        </div>
        <form
          className="cw-scrollbar flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-5"
          onSubmit={(event) => {
            event.preventDefault()
            void submit()
          }}
        >
          <div className="flex items-center gap-3">
            <Avatar initials={name.trim() ? initialsOfName(name) : "?"} tone={tone} size={40} />
            <div className="flex items-center gap-1.5">
              {AVATAR_TONES.map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setTone(t)}
                  title={t}
                  aria-label={`Color ${t}`}
                  className={cn(
                    "size-5 rounded-full border-2",
                    tone === t ? "border-cw-text" : "border-transparent hover:border-cw-border"
                  )}
                  style={{ backgroundColor: AVATAR_STYLES[t].bg }}
                />
              ))}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <label className="flex w-full flex-col gap-1.5">
              <span className="text-xs font-semibold text-cw-secondary">Name</span>
              <input
                autoFocus
                value={name}
                onChange={(event) => {
                  setName(event.target.value)
                  if (!handleTouched) setHandle(slugHandle(event.target.value))
                }}
                className={inputClass}
                placeholder="e.g. Coder (fast)"
              />
            </label>
            <label className="flex w-full flex-col gap-1.5">
              <span className="text-xs font-semibold text-cw-secondary">Handle</span>
              <input
                value={handle}
                onChange={(event) => {
                  setHandleTouched(true)
                  setHandle(event.target.value)
                }}
                className={inputClass}
                placeholder="coder_fast"
                spellCheck={false}
              />
            </label>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <label className="flex w-full flex-col gap-1.5">
              <span className="text-xs font-semibold text-cw-secondary">Role</span>
              <div className="relative">
                <select value={role} onChange={(event) => setRole(event.target.value as AgentRole)} className={selectClass}>
                  <option value="coder">Coder — implements cards</option>
                  <option value="architect">Architect — plans, dispatches, reviews</option>
                </select>
                <Icon src="/icons/chevron-down.svg" size={16} className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2" />
              </div>
            </label>
            <label className="flex w-full flex-col gap-1.5">
              <span className="text-xs font-semibold text-cw-secondary">Engine</span>
              <div className="relative">
                <select value={engine} onChange={(event) => setEngine(event.target.value as AgentEngine)} className={selectClass}>
                  <option value="claude">Claude Code</option>
                  <option value="codex">Codex CLI</option>
                  <option value="stub">Stub (no model)</option>
                </select>
                <Icon src="/icons/chevron-down.svg" size={16} className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2" />
              </div>
            </label>
          </div>

          <div className="grid grid-cols-[1fr_140px_110px] gap-3">
            <label className="flex w-full flex-col gap-1.5">
              <span className="text-xs font-semibold text-cw-secondary">Model</span>
              <input
                value={model}
                onChange={(event) => setModel(event.target.value)}
                className={inputClass}
                placeholder="default"
                spellCheck={false}
              />
            </label>
            <label className="flex w-full flex-col gap-1.5">
              <span className="text-xs font-semibold text-cw-secondary">Effort</span>
              <div className="relative">
                <select
                  value={effort}
                  onChange={(event) => setEffort(event.target.value as AgentEffort | "")}
                  className={selectClass}
                >
                  <option value="">Default</option>
                  {AGENT_EFFORTS.map((level) => (
                    <option key={level} value={level}>
                      {EFFORT_LABELS[level]}
                    </option>
                  ))}
                </select>
                <Icon src="/icons/chevron-down.svg" size={16} className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2" />
              </div>
            </label>
            <label className="flex w-full flex-col gap-1.5">
              <span className="text-xs font-semibold text-cw-secondary">Max turns</span>
              <input
                value={maxTurns}
                onChange={(event) => setMaxTurns(event.target.value.replace(/[^0-9]/g, ""))}
                className={inputClass}
                placeholder={role === "coder" ? "80" : "20"}
                inputMode="numeric"
              />
            </label>
          </div>
          <span className="-mt-2 text-[11px] leading-[1.4] text-cw-placeholder">
            {MODEL_HINTS[engine]}. Effort: Claude Code low / medium / high / max; Codex low / medium / high / xhigh
            (Max). Which levels exist depends on the model.
          </span>
          {engineMissing && (
            <span className="-mt-2 text-[11px] leading-[1.4] font-medium text-[#a06a00]">
              The worker could not find {ENGINE_LABELS[engine]} on this computer — runs of this agent will fail until it is
              installed and logged in ({engine === "claude" ? "npm i -g @anthropic-ai/claude-code, then claude" : "npm i -g @openai/codex, then codex login"}).
            </span>
          )}

          <label className="flex w-full flex-col gap-1.5">
            <span className="text-xs font-semibold text-cw-secondary">What this agent is for</span>
            <input
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              className={inputClass}
              placeholder={role === "coder" ? "e.g. Small UI fixes, fast and cheap" : "e.g. Plans, dispatches the queue, reviews"}
            />
            <span className="text-[11px] leading-[1.4] text-cw-placeholder">
              One line. The Architect reads it when it decides which coder takes a card.
            </span>
          </label>

          <label className="flex w-full flex-col gap-1.5">
            <span className="text-xs font-semibold text-cw-secondary">Instructions</span>
            <textarea
              value={instructions}
              onChange={(event) => setInstructions(event.target.value)}
              rows={5}
              className={cn(inputClass, "resize-y leading-[1.45]")}
              placeholder="Extra rules for this agent, appended to its role prompt. e.g. Never touch src/components/kanban-app.tsx without asking. Always run npm run typecheck before committing."
            />
          </label>

          {error && <p className="text-[12px] font-medium text-[#b25959]">{error}</p>}
        </form>

        <div className="flex items-center justify-between gap-2 border-t border-cw-border px-5 py-4">
          <div>
            {agent && !confirmRemove && (
              <button
                type="button"
                disabled={busy}
                onClick={() => setConfirmRemove(true)}
                className="text-[13px] font-bold text-[#b25959] hover:underline disabled:opacity-50"
              >
                Remove agent
              </button>
            )}
            {agent && confirmRemove && (
              <span className="flex items-center gap-2 text-[12px] text-cw-secondary">
                Off every board, tags removed?
                <button type="button" disabled={busy} onClick={() => void remove()} className="font-bold text-[#b25959] hover:underline">
                  Yes, remove
                </button>
                <button type="button" onClick={() => setConfirmRemove(false)} className="font-bold text-cw-text hover:underline">
                  No
                </button>
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-cw-border bg-white px-4 py-2.5 text-[13px] font-bold text-cw-text hover:bg-[#faf9f7]"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={!canSave}
              onClick={() => void submit()}
              className="rounded-md bg-cw-accent px-4 py-2.5 text-[13px] font-bold text-white hover:bg-[#d99c1c] disabled:opacity-50"
            >
              {busy ? "Saving…" : creating ? "Create agent" : "Save changes"}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

/** Mirrors the server: "Coder (fast)" → "CF". */
function initialsOfName(name: string): string {
  const parts = name.split(/[^\p{L}\p{N}]+/u).filter(Boolean)
  const letters = parts.length >= 2 ? parts[0][0] + parts[parts.length - 1][0] : (parts[0] ?? name.trim()).slice(0, 2)
  return letters.toUpperCase()
}

/** Mirrors the server: "Coder (fast)" → "coder_fast". */
function slugHandle(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[^\x00-\x7F]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 32)
}

// ---------------------------------------------------------------------------
// Board viewport — columns stretch to fill the width and never shrink below
// 300px; when they don't fit, the board scrolls sideways and empty space can be
// dragged with the mouse to pan (cards keep their own drag-and-drop).

function BoardScroller({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const pan = useRef<{ pointerId: number; startX: number; startLeft: number } | null>(null)

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !ref.current) return
    if (ref.current.scrollWidth <= ref.current.clientWidth) return
    const target = event.target as HTMLElement
    if (target.closest("button, input, textarea, select, a, [role='button'], [data-column-handle]")) return
    pan.current = { pointerId: event.pointerId, startX: event.clientX, startLeft: ref.current.scrollLeft }
    ref.current.setPointerCapture(event.pointerId)
    ref.current.classList.add("cursor-grabbing", "select-none")
  }

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!pan.current || !ref.current || event.pointerId !== pan.current.pointerId) return
    ref.current.scrollLeft = pan.current.startLeft - (event.clientX - pan.current.startX)
  }

  const endPan = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!pan.current || !ref.current || event.pointerId !== pan.current.pointerId) return
    pan.current = null
    try {
      ref.current.releasePointerCapture(event.pointerId)
    } catch {
      // capture already released
    }
    ref.current.classList.remove("cursor-grabbing", "select-none")
  }

  return (
    <div
      ref={ref}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endPan}
      onPointerCancel={endPan}
      className="cw-hscroll flex min-w-0 flex-1 gap-0 overflow-x-auto overflow-y-hidden bg-cw-bg p-[18px]"
    >
      {children}
    </div>
  )
}

// ---------------------------------------------------------------------------
// The app

export function KanbanApp() {
  const [state, setState] = useState<BoardState | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  /** Latest heartbeat from the agent worker (SSE); null until the first state load. */
  const [worker, setWorker] = useState<WorkerStatus | null>(null)
  const workerSeen = useRef(0)
  const [activeBoardId, setActiveBoardId] = useState<string | null>(null)
  const [selection, setSelection] = useState<Record<string, Selection>>({})
  const [thread, setThread] = useState<TaskThread | null>(null)
  const [search, setSearch] = useState("")
  const [modal, setModal] = useState<ModalState | null>(null)
  const [boardDialog, setBoardDialog] = useState<
    { mode: "edit" | "delete"; board: Board } | { mode: "create"; board: null } | null
  >(null)
  const [archiveColumn, setArchiveColumn] = useState<ColumnView | null>(null)
  const [archiveBusy, setArchiveBusy] = useState(false)
  const [deleteColumn, setDeleteColumn] = useState<ColumnView | null>(null)
  const [deleteColumnBusy, setDeleteColumnBusy] = useState(false)
  const [deleteColumnError, setDeleteColumnError] = useState<string | null>(null)
  /** "board" shows the lists, "archive" the board's archived cards, "agents" the workspace's agents. */
  const [view, setView] = useState<"board" | "archive" | "agents">("board")
  const [agentDialog, setAgentDialog] = useState<{ agent: Member | null } | null>(null)
  const [archived, setArchived] = useState<{ boardId: string; tasks: Task[] } | null>(null)
  const [archivedError, setArchivedError] = useState<string | null>(null)
  const [archivedBusyId, setArchivedBusyId] = useState<string | null>(null)
  const [boardBusy, setBoardBusy] = useState(false)
  const [boardError, setBoardError] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [activeCard, setActiveCard] = useState<CardView | null>(null)
  const [activeCardWidth, setActiveCardWidth] = useState<number | null>(null)
  // Gate @dnd-kit until after hydration so SSR HTML matches the first client paint.
  const dndReady = useSyncExternalStore(subscribeNoop, getClientTrue, getServerFalse)
  const [draftMessage, setDraftMessage] = useState("")
  const [mentionIndex, setMentionIndex] = useState(0)
  const [sending, setSending] = useState(false)
  const [localColumns, setLocalColumnsState] = useState<ColumnView[] | null>(null)
  const localColumnsRef = useRef<ColumnView[] | null>(null)
  /** True for one frame after a card changed column mid-drag; see handleDragOver. */
  const justCrossed = useRef(false)
  const chatEndRef = useRef<HTMLDivElement>(null)
  const selectedTaskRef = useRef<string | null>(null)

  const setLocalColumns = useCallback((next: ColumnView[] | null) => {
    localColumnsRef.current = next
    setLocalColumnsState(next)
  }, [])

  // --- data loading ---------------------------------------------------------

  const refreshState = useCallback(async () => {
    try {
      const next = await api.state()
      setState(next)
      setLoadError(null)
      if (next.worker) {
        setWorker(next.worker)
        if (next.worker.online) workerSeen.current = Date.now()
      }
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Could not load the board")
    }
  }, [])

  const refreshThread = useCallback(async (taskId: string | null) => {
    if (!taskId) {
      setThread(null)
      return
    }
    try {
      const next = await api.thread(taskId)
      // The user may have switched tasks while we were fetching.
      if (selectedTaskRef.current === taskId) setThread(next)
    } catch {
      if (selectedTaskRef.current === taskId) setThread(null)
    }
  }, [])

  useEffect(() => {
    // Initial load + subscription to the board's change stream (external system).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refreshState()

    let timer: ReturnType<typeof setTimeout> | null = null
    const source = new EventSource("/api/events")
    source.onmessage = (event) => {
      let payload: { type?: string; scope?: string; taskId?: string; status?: WorkerStatus } = {}
      try {
        payload = JSON.parse(event.data)
      } catch {
        return
      }
      if (payload.type === "worker" && payload.status) {
        workerSeen.current = Date.now()
        setWorker(payload.status)
        return
      }
      if (payload.type !== "change") return
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        void refreshState()
        const open = selectedTaskRef.current
        if (open && (!payload.taskId || payload.taskId === open || payload.scope === "board")) {
          void refreshThread(open)
        }
      }, 120)
    }
    // No heartbeat for a while → the worker is gone; say so without waiting for a refetch.
    const stale = setInterval(() => {
      if (workerSeen.current && Date.now() - workerSeen.current > 15000) {
        setWorker((prev) => (prev && prev.online ? { ...prev, online: false } : prev))
      }
    }, 5000)
    return () => {
      if (timer) clearTimeout(timer)
      clearInterval(stale)
      source.close()
    }
  }, [refreshState, refreshThread])

  // --- derived --------------------------------------------------------------

  const members = useMemo(() => state?.members ?? [], [state])
  const byId = useMemo(() => new Map(members.map((m) => [m.id, m])), [members])
  const byHandle = useMemo(() => new Map(members.map((m) => [m.handle.toLowerCase(), m])), [members])

  const activeBoard: Board | null = useMemo(() => {
    if (!state) return null
    return state.boards.find((b) => b.id === activeBoardId) ?? state.boards[0] ?? null
  }, [state, activeBoardId])

  const boardSelection: Selection = (activeBoard && selection[activeBoard.id]) || {
    selectedId: null,
    panelOpen: false,
  }
  const { selectedId, panelOpen } = boardSelection

  const updateSelection = useCallback(
    (patch: Partial<Selection>) => {
      if (!activeBoard) return
      setSelection((prev) => ({
        ...prev,
        [activeBoard.id]: { ...(prev[activeBoard.id] ?? { selectedId: null, panelOpen: false }), ...patch },
      }))
      // A different task (or a closed panel) starts with an empty composer.
      setDraftMessage("")
      setMentionIndex(0)
    },
    [activeBoard]
  )

  const selectedTask: Task | null = useMemo(() => {
    if (!activeBoard || !selectedId) return null
    for (const column of activeBoard.columns) {
      const task = column.tasks.find((t) => t.id === selectedId)
      if (task) return task
    }
    // An archived card is not in any list, but it can still be open in the panel.
    if (archived?.boardId !== activeBoard.id) return null
    return archived.tasks.find((t) => t.id === selectedId) ?? null
  }, [activeBoard, selectedId, archived])

  const openTaskId = panelOpen && selectedTask ? selectedTask.id : null

  useEffect(() => {
    selectedTaskRef.current = openTaskId
    // Fetch the thread of the task that just opened (external system).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refreshThread(openTaskId)
  }, [openTaskId, refreshThread])

  /** Titles of the board's open cards (not in Review / Done) by id — for "waits for …" labels. */
  const openCardTitles = useMemo(() => {
    const map = new Map<string, string>()
    for (const column of activeBoard?.columns ?? []) {
      if (column.role === "review" || column.role === "done") continue
      for (const task of column.tasks) map.set(task.id, task.title)
    }
    return map
  }, [activeBoard])
  const allCardTitles = useMemo(() => {
    const map = new Map<string, string>()
    for (const column of activeBoard?.columns ?? []) for (const task of column.tasks) map.set(task.id, task.title)
    return map
  }, [activeBoard])
  const waitingFor = useCallback(
    (task: Task) => task.blockedBy.map((id) => openCardTitles.get(id)).filter((t): t is string => !!t),
    [openCardTitles]
  )

  const serverColumns: ColumnView[] = useMemo(() => {
    if (!activeBoard) return []
    const needle = search.trim().toLowerCase()
    return activeBoard.columns.map((column) => ({
      id: column.id,
      title: column.title,
      role: column.role,
      cards: column.tasks
        .filter(
          (task) =>
            !needle ||
            task.title.toLowerCase().includes(needle) ||
            task.description.toLowerCase().includes(needle)
        )
        .map((task) => ({
          ...task,
          assignees: task.assigneeIds.map((id) => byId.get(id)).filter((m): m is Member => !!m),
          selected: task.id === selectedId && panelOpen,
          waitingFor: waitingFor(task),
        })),
    }))
  }, [activeBoard, byId, selectedId, panelOpen, search, waitingFor])

  const columns = localColumns ?? serverColumns

  // --- archive --------------------------------------------------------------

  const archiveBoardId = view === "archive" ? activeBoard?.id ?? null : null
  const archivedCount = activeBoard?.archivedCount ?? 0

  const loadArchived = useCallback(async (boardId: string) => {
    try {
      const result = await api.archivedTasks(boardId)
      setArchived({ boardId, tasks: result.tasks })
      setArchivedError(null)
    } catch (err) {
      setArchivedError(err instanceof Error ? err.message : "Could not load the archive")
    }
  }, [])

  useEffect(() => {
    // Archived cards are not part of /api/state — fetch them while the view is open,
    // and again whenever the board's archived count changes (external system).
    if (!archiveBoardId) return
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadArchived(archiveBoardId)
  }, [archiveBoardId, archivedCount, loadArchived])

  // Cards of another board (or of a closed archive) are not shown while the new ones load.
  const archivedTasks = archived && archived.boardId === archiveBoardId ? archived.tasks : null

  const archivedCards: CardView[] = useMemo(() => {
    const needle = search.trim().toLowerCase()
    return (archivedTasks ?? [])
      .filter(
        (task) =>
          !needle ||
          task.title.toLowerCase().includes(needle) ||
          task.description.toLowerCase().includes(needle)
      )
      .map((task) => ({
        ...task,
        assignees: task.assigneeIds.map((id) => byId.get(id)).filter((m): m is Member => !!m),
        selected: task.id === selectedId && panelOpen,
        waitingFor: [],
      }))
  }, [archivedTasks, byId, selectedId, panelOpen, search])

  const boardMembers = useMemo(
    () => (activeBoard ? activeBoard.memberIds.map((id) => byId.get(id)).filter((m): m is Member => !!m) : []),
    [activeBoard, byId]
  )

  // --- drag & drop ----------------------------------------------------------

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }))

  const handleDragStart = (event: DragStartEvent) => {
    if (event.active.data.current?.type === "column") return
    justCrossed.current = false
    const base = localColumnsRef.current ?? serverColumns
    setLocalColumns(base)
    setActiveCard(findCard(base, String(event.active.id)) ?? null)

    const target =
      event.activatorEvent.target instanceof Element ? event.activatorEvent.target.closest("button") : null
    const width =
      target?.getBoundingClientRect().width ??
      event.active.rect.current.initial?.width ??
      event.active.rect.current.translated?.width ??
      null
    setActiveCardWidth(width)
  }

  const handleDragOver = (event: DragOverEvent) => {
    const { active, over } = event
    if (!over || active.data.current?.type === "column") return
    const activeId = String(active.id)
    const overId = String(over.id)
    if (activeId === overId) return

    const prev = localColumnsRef.current ?? serverColumns
    const activeColumnId = findColumnId(prev, activeId)
    const overColumnId = findColumnId(prev, overId)
    if (!activeColumnId || !overColumnId) return
    const sourceIndex = prev.findIndex((column) => column.id === activeColumnId)
    const destIndex = prev.findIndex((column) => column.id === overColumnId)
    if (sourceIndex < 0 || destIndex < 0) return

    // Inside one column the sortable strategy already shifts the cards visually; the real
    // reorder happens on drop. Reordering state here too makes the layout and `over` chase
    // each other on fast drags until React gives up ("Maximum update depth exceeded").
    if (activeColumnId === overColumnId) return

    const sourceCards = [...prev[sourceIndex].cards]
    const destCards = [...prev[destIndex].cards]
    const cardIndex = sourceCards.findIndex((card) => card.id === activeId)
    if (cardIndex < 0) return
    const [moved] = sourceCards.splice(cardIndex, 1)
    const overCardIndex = destCards.findIndex((card) => card.id === overId)
    let insertAt: number
    if (overId === overColumnId) {
      insertAt = destCards.length
    } else if (overCardIndex >= 0) {
      const isBelowOverItem =
        active.rect.current.translated && active.rect.current.translated.top > over.rect.top + over.rect.height
      insertAt = overCardIndex + (isBelowOverItem ? 1 : 0)
    } else {
      insertAt = destCards.length
    }
    destCards.splice(Math.min(insertAt, destCards.length), 0, moved)
    // Let the layout settle for a frame after a crossing before reacting to `over` again
    // (dnd-kit's own multi-container recipe), otherwise a fast drag can ping-pong between columns.
    if (justCrossed.current) return
    justCrossed.current = true
    requestAnimationFrame(() => {
      justCrossed.current = false
    })
    setLocalColumns(
      prev.map((column, index) => {
        if (index === sourceIndex) return { ...column, cards: sourceCards }
        if (index === destIndex) return { ...column, cards: destCards }
        return column
      })
    )
  }

  const persistMove = async (taskId: string, columnId: string, position: number) => {
    try {
      await api.updateTask(taskId, { columnId, position })
      await refreshState()
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Could not move the task")
      await refreshState()
    } finally {
      setLocalColumns(null)
    }
  }

  const persistColumnMove = async (columnId: string, position: number) => {
    try {
      await api.updateColumn(columnId, { position })
      await refreshState()
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Could not move the list")
      await refreshState()
    } finally {
      setLocalColumns(null)
    }
  }

  const handleColumnDragEnd = ({ active, over }: DragEndEvent) => {
    const cols = localColumnsRef.current ?? serverColumns
    const fromIndex = cols.findIndex((column) => COLUMN_DRAG_PREFIX + column.id === active.id)
    const toIndex = over ? cols.findIndex((column) => COLUMN_DRAG_PREFIX + column.id === over.id) : -1
    if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return
    setLocalColumns(arrayMove(cols, fromIndex, toIndex))
    void persistColumnMove(cols[fromIndex].id, toIndex)
  }

  const handleDragEnd = (event: DragEndEvent) => {
    if (event.active.data.current?.type === "column") {
      handleColumnDragEnd(event)
      return
    }
    const { active, over } = event
    setActiveCard(null)
    setActiveCardWidth(null)
    const activeId = String(active.id)
    let cols = localColumnsRef.current ?? serverColumns

    if (over) {
      const overId = String(over.id)
      const columnId = findColumnId(cols, activeId)
      const overColumnId = findColumnId(cols, overId)
      if (columnId && overColumnId && columnId === overColumnId && activeId !== overId) {
        const columnIndex = cols.findIndex((column) => column.id === columnId)
        const cards = cols[columnIndex].cards
        const oldIndex = cards.findIndex((card) => card.id === activeId)
        const newIndex = overId === overColumnId ? cards.length - 1 : cards.findIndex((card) => card.id === overId)
        if (oldIndex >= 0 && newIndex >= 0 && oldIndex !== newIndex) {
          cols = cols.map((column, index) =>
            index === columnIndex ? { ...column, cards: arrayMove(cards, oldIndex, newIndex) } : column
          )
        }
      }
    }

    const target = cols.find((column) => column.cards.some((card) => card.id === activeId))
    if (!target) {
      setLocalColumns(null)
      return
    }
    const index = target.cards.findIndex((card) => card.id === activeId)
    const before = serverColumns.find((column) => column.cards.some((card) => card.id === activeId))
    const beforeIndex = before ? before.cards.findIndex((card) => card.id === activeId) : -1
    if (before && before.id === target.id && beforeIndex === index) {
      setLocalColumns(null)
      return
    }
    setLocalColumns(cols)
    void persistMove(activeId, target.id, index)
  }

  const handleDragCancel = () => {
    setActiveCard(null)
    setActiveCardWidth(null)
    setLocalColumns(null)
  }

  // --- chat -----------------------------------------------------------------

  const mentionCandidates = useMemo(() => {
    const seen = new Map<string, Member>()
    for (const member of boardMembers) seen.set(member.id, member)
    if (selectedTask) {
      for (const id of selectedTask.assigneeIds) {
        const member = byId.get(id)
        if (member) seen.set(member.id, member)
      }
    }
    return Array.from(seen.values()).filter((member) => member.id !== state?.me.id)
  }, [boardMembers, selectedTask, byId, state?.me.id])

  const mentionQuery = getMentionQuery(draftMessage)
  const filteredMentions =
    mentionQuery == null
      ? []
      : mentionCandidates.filter(
          (member) =>
            member.handle.toLowerCase().startsWith(mentionQuery) ||
            member.name.toLowerCase().startsWith(mentionQuery) ||
            member.initials.toLowerCase().startsWith(mentionQuery)
        )

  const messages: Message[] = thread && thread.task.id === openTaskId ? thread.messages : []
  const runs: Run[] = thread && thread.task.id === openTaskId ? thread.runs : []

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [messages.length, openTaskId])

  const insertMention = (member: Member) => {
    setDraftMessage((prev) =>
      prev.replace(/(?:^|\s)@([\w]*)$/, (match) => {
        const prefix = match.startsWith(" ") ? " " : ""
        return `${prefix}@${member.handle} `
      })
    )
    setMentionIndex(0)
  }

  const sendMessage = async () => {
    const text = draftMessage.trim()
    if (!text || !openTaskId || sending) return
    setSending(true)
    try {
      await api.sendMessage(openTaskId, text)
      setDraftMessage("")
      setMentionIndex(0)
      await refreshThread(openTaskId)
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Could not send the message")
    } finally {
      setSending(false)
    }
  }

  // --- board switching & modal ----------------------------------------------

  const switchBoard = (boardId: string) => {
    if (boardId === activeBoardId) return
    setActiveCard(null)
    setActiveCardWidth(null)
    setLocalColumns(null)
    setSearch("")
    setDraftMessage("")
    setMentionIndex(0)
    setActiveBoardId(boardId)
  }

  const selectCard = (id: string) => updateSelection({ selectedId: id, panelOpen: true })

  const onTaskSaved = async (task: Task) => {
    setModal(null)
    // A card that is not archived lives on the board — follow it there.
    if (!task.archived) setView("board")
    await refreshState()
    if (task.boardId === activeBoard?.id) {
      updateSelection({ selectedId: task.id, panelOpen: true })
    }
  }

  const onTaskDeleted = async () => {
    setModal(null)
    updateSelection({ selectedId: null, panelOpen: false })
    await refreshState()
  }

  const onBoardCreated = async (board: Board) => {
    setModal(null)
    setBoardDialog(null)
    await refreshState()
    switchBoard(board.id)
  }

  const openNewBoard = () => {
    setModal(null)
    setBoardError(null)
    setBoardDialog({ mode: "create", board: null })
  }

  const openBoardDialog = (mode: "edit" | "delete", board: Board) => {
    setBoardError(null)
    setBoardDialog({ mode, board })
  }

  const confirmDeleteBoard = async () => {
    if (!boardDialog || boardDialog.mode !== "delete") return
    setBoardBusy(true)
    setBoardError(null)
    try {
      await api.deleteBoard(boardDialog.board.id)
      setBoardDialog(null)
      if (boardDialog.board.id === activeBoard?.id) {
        setActiveBoardId(null)
        setLocalColumns(null)
      }
      await refreshState()
    } catch (err) {
      setBoardError(err instanceof Error ? err.message : "Could not delete the board")
    } finally {
      setBoardBusy(false)
    }
  }

  // --- render ---------------------------------------------------------------

  const me = state?.me ?? null
  const panelTask = openTaskId ? (thread && thread.task.id === openTaskId ? thread.task : selectedTask) : null
  const panelAssignees = panelTask
    ? panelTask.assigneeIds.map((id) => byId.get(id)).filter((m): m is Member => !!m)
    : []
  const participants = new Set<string>([...panelAssignees.map((m) => m.id), ...messages.map((m) => m.authorId)])

  const columnProps = {
    columnCount: columns.length,
    byId,
    onSelectCard: selectCard,
    onAddCard: (columnId: string) => setModal({ mode: "create", columnId }),
    onRenameColumn: async (columnId: string, title: string) => {
      await api.updateColumn(columnId, { title })
      await refreshState()
    },
    onDeleteColumn: async (columnId: string) => {
      const column = columns.find((c) => c.id === columnId)
      if (column && column.cards.length > 0) {
        setDeleteColumnError(null)
        setDeleteColumn(column)
        return
      }
      await api.deleteColumn(columnId)
      await refreshState()
    },
    onArchiveColumn: (column: ColumnView) => setArchiveColumn(column),
  }

  const confirmDeleteColumn = async (cards: "delete" | "archive") => {
    if (!deleteColumn) return
    setDeleteColumnBusy(true)
    setDeleteColumnError(null)
    try {
      await api.deleteColumn(deleteColumn.id, cards)
      setDeleteColumn(null)
      await refreshState()
    } catch (err) {
      setDeleteColumnError(err instanceof Error ? err.message : "Could not delete")
    } finally {
      setDeleteColumnBusy(false)
    }
  }

  const confirmArchiveColumn = async () => {
    if (!archiveColumn) return
    setArchiveBusy(true)
    try {
      await api.archiveColumn(archiveColumn.id)
      setArchiveColumn(null)
      await refreshState()
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Could not archive")
    } finally {
      setArchiveBusy(false)
    }
  }

  const actOnArchived = async (task: Task, action: "restore" | "delete") => {
    setArchivedBusyId(task.id)
    setArchivedError(null)
    try {
      if (action === "restore") await api.updateTask(task.id, { archived: false })
      else {
        await api.deleteTask(task.id)
        if (selectedId === task.id) updateSelection({ selectedId: null, panelOpen: false })
      }
      if (activeBoard) await loadArchived(activeBoard.id)
      await refreshState()
    } catch (err) {
      setArchivedError(err instanceof Error ? err.message : "Something went wrong")
    } finally {
      setArchivedBusyId(null)
    }
  }

  const addColumn = async (title: string) => {
    if (!activeBoard) return
    await api.createColumn(activeBoard.id, { title })
    await refreshState()
  }

  return (
    <div className="flex h-dvh min-h-[700px] w-full overflow-hidden bg-white">
      {/* Sidebar */}
      <aside className="cw-sidebar-shadow relative z-10 flex w-[220px] shrink-0 flex-col overflow-hidden border-r border-cw-border bg-white">
        <div className="flex w-full flex-col overflow-y-auto">
          <div className="flex h-16 items-center gap-2.5 border-b border-cw-border px-[18px]">
            <span className="text-[34px] font-black leading-none text-[#f2a000]">CS</span>
            <div className="flex flex-col gap-px">
              <span className="text-xs text-cw-text">Creative Space</span>
              <span className="text-[10px] text-cw-secondary">Workspace</span>
            </div>
          </div>

          <nav className="flex flex-col gap-0.5 pt-7">
            <NavItem
              icon="/icons/bot.svg"
              label="Agents"
              active={view === "agents"}
              onClick={() => setView(view === "agents" ? "board" : "agents")}
            />
            <NavItem
              icon="/icons/archive.svg"
              label="Archive"
              active={view === "archive"}
              onClick={() => setView(view === "archive" ? "board" : "archive")}
            />
            <NavItem icon="/icons/settings.svg" label="Workspace settings" onClick={() => setSettingsOpen(true)} />
          </nav>

          <p className="pl-[18px] pt-7 text-xs font-bold text-cw-text">Workspace views</p>
          <nav className="flex flex-col pt-2">
            <NavItem icon="/icons/grid.svg" label="Table" />
            <NavItem icon="/icons/calendar.svg" label="Calendar" />
          </nav>

          <p className="pl-[18px] pt-7 text-xs font-bold text-cw-text">Your boards</p>
          <nav className="flex flex-col pt-2">
            {(state?.boards ?? []).map((board) => (
              <BoardNavItem
                key={board.id}
                board={board}
                active={view === "board" && board.id === activeBoard?.id}
                onSelect={() => {
                  setView("board")
                  switchBoard(board.id)
                }}
                onEdit={() => openBoardDialog("edit", board)}
                onDelete={() => openBoardDialog("delete", board)}
              />
            ))}
            <button
              type="button"
              onClick={openNewBoard}
              className="flex h-10 w-full items-center gap-3 pl-[18px] text-left text-xs text-cw-secondary hover:bg-[#faf9f7] hover:text-cw-text"
            >
              <span className="flex size-4 items-center justify-center text-base leading-none">+</span>
              New board
            </button>
          </nav>
        </div>
      </aside>

      {/* Main */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* z-20: above the task panel, so its shadow can't bleed under the header */}
        <header className="relative z-20 flex h-16 shrink-0 items-center justify-between gap-4 border-b border-cw-border bg-white px-[18px]">
          <div className="flex min-w-0 items-center gap-4">
            <p className="shrink-0 whitespace-pre text-xs text-cw-secondary">
              {`Workspace  /  ${view === "agents" ? "Agents" : (activeBoard?.name ?? "…")}`}
            </p>
            <label className="flex w-[250px] max-w-full items-center gap-2 rounded-md bg-cw-bg px-3 py-2">
              <Icon src="/icons/search.svg" size={14} />
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                className="w-full bg-transparent text-xs text-cw-text outline-none placeholder:text-cw-placeholder"
                placeholder="Search tasks"
              />
            </label>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            {loadError && (
              <button
                type="button"
                onClick={() => void refreshState()}
                title={loadError}
                className="max-w-[260px] truncate rounded-md border border-[#e9c9c9] bg-[#fbf3f3] px-3 py-2 text-[11px] font-semibold text-[#b25959]"
              >
                {loadError} · retry
              </button>
            )}
            {view === "agents" ? (
              <button
                type="button"
                onClick={() => setAgentDialog({ agent: null })}
                className="rounded-md bg-cw-accent px-4 py-2 text-[13px] font-bold text-white hover:bg-[#d99c1c]"
              >
                + New agent
              </button>
            ) : (
              <button
                type="button"
                disabled={!activeBoard}
                onClick={() => setModal({ mode: "create" })}
                className="rounded-md bg-cw-accent px-4 py-2 text-[13px] font-bold text-white hover:bg-[#d99c1c] disabled:opacity-50"
              >
                + Create
              </button>
            )}
            {worker && <WorkerPill worker={worker} onClick={() => setView("agents")} />}
            {me && <UserMenu me={me} onOpenSettings={() => setSettingsOpen(true)} />}
          </div>
        </header>

        <div className="flex min-h-0 flex-1">
          {!state ? (
            <div className="flex min-w-0 flex-1 items-center justify-center bg-cw-bg text-xs text-cw-placeholder">
              {loadError ?? "Loading board…"}
            </div>
          ) : view === "agents" ? (
            <AgentsView
              agents={members.filter((m) => m.kind === "agent" && !m.archived)}
              boards={state.boards}
              worker={worker}
              onEdit={(agent) => setAgentDialog({ agent })}
              onCreate={() => setAgentDialog({ agent: null })}
            />
          ) : !activeBoard ? (
            <div className="flex min-w-0 flex-1 items-center justify-center bg-cw-bg">
              <div className="flex w-[360px] max-w-full flex-col items-center gap-3 text-center">
                <p className="text-lg font-bold text-cw-text">No boards yet</p>
                <p className="text-[13px] leading-[1.5] text-cw-secondary">
                  A board is one project: the folder with its code and the agents that work in it. Cards in
                  Ready are picked up by the Coder; the Architect plans and reviews.
                </p>
                <button
                  type="button"
                  onClick={openNewBoard}
                  className="mt-2 rounded-md bg-cw-accent px-4 py-2.5 text-[13px] font-bold text-white hover:bg-[#d99c1c]"
                >
                  Create your first board
                </button>
              </div>
            </div>
          ) : view === "archive" ? (
            <ArchiveView
              cards={archivedCards}
              byId={byId}
              loading={archivedTasks == null && !archivedError}
              error={archivedError}
              busyId={archivedBusyId}
              onSelect={selectCard}
              onRestore={(card) => void actOnArchived(card, "restore")}
              onDelete={(card) => void actOnArchived(card, "delete")}
            />
          ) : dndReady ? (
            <DndContext
              key={activeBoard.id}
              sensors={sensors}
              collisionDetection={collisionDetection}
              onDragStart={handleDragStart}
              onDragOver={handleDragOver}
              onDragEnd={handleDragEnd}
              onDragCancel={handleDragCancel}
            >
              <BoardScroller>
                <SortableContext
                  items={columns.map((column) => COLUMN_DRAG_PREFIX + column.id)}
                  strategy={horizontalListSortingStrategy}
                >
                  {columns.map((column, columnIndex) => (
                    <SortableKanbanColumn
                      key={`${activeBoard.id}-${column.id}`}
                      column={column}
                      columnIndex={columnIndex}
                      {...columnProps}
                    />
                  ))}
                </SortableContext>
                <AddListSlot onAdd={addColumn} />
              </BoardScroller>
              <DragOverlay dropAnimation={null}>
                {activeCard ? (
                  <div
                    className="w-full rotate-[2deg] cursor-grabbing"
                    style={activeCardWidth != null ? { width: activeCardWidth } : undefined}
                  >
                    <TaskCardContent card={{ ...activeCard, selected: false }} byId={byId} dragging />
                  </div>
                ) : null}
              </DragOverlay>
            </DndContext>
          ) : (
            <BoardScroller>
              {columns.map((column, columnIndex) => (
                <StaticKanbanColumn
                  key={`${activeBoard?.id}-${column.id}`}
                  column={column}
                  columnIndex={columnIndex}
                  {...columnProps}
                />
              ))}
              <AddListSlot onAdd={addColumn} />
            </BoardScroller>
          )}

          {/* Detail panel — driven by the selected card */}
          {panelTask && activeBoard && (
            <aside className="cw-panel-shadow relative z-10 flex w-[20%] min-w-[290px] shrink-0 flex-col overflow-hidden border-l border-cw-border bg-white">
              <button
                type="button"
                onClick={() => updateSelection({ panelOpen: false })}
                className="flex h-[52px] shrink-0 items-center gap-2 border-b border-cw-border px-4 text-xs text-cw-secondary hover:bg-[#faf9f7]"
              >
                <Icon src="/icons/arrow-left.svg" size={14} />
                Back
              </button>

              <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                <div className="shrink-0 border-b border-cw-border p-4">
                  <div className="mb-[9px] flex items-center justify-between gap-2">
                    <h2 className="min-w-0 text-lg font-bold leading-tight text-cw-text">{panelTask.title}</h2>
                    <button
                      type="button"
                      onClick={() => setModal({ mode: "edit", task: panelTask })}
                      className="flex size-7 shrink-0 items-center justify-center rounded-md border border-[#e4e2de] hover:bg-[#faf9f7]"
                      aria-label="Edit task"
                    >
                      <Icon src="/icons/edit.svg" size={14} />
                    </button>
                  </div>
                  {panelTask.description && (
                    <p className="mb-[9px] whitespace-pre-line text-xs leading-[1.4] text-cw-secondary">
                      {renderRichText(panelTask.description, byHandle)}
                    </p>
                  )}
                  <div className="flex flex-wrap items-center gap-1.5">
                    <PriorityPill priority={panelTask.priority} large />
                    <AgentBadge card={panelTask} byId={byId} large />
                    {panelTask.agentStatus && (
                      <StopRunButton
                        runId={panelTask.agentStatus.runId}
                        requested={runs.some((r) => r.id === panelTask.agentStatus?.runId && r.cancelRequested)}
                        onStopped={() => void refreshThread(panelTask.id)}
                      />
                    )}
                  </div>
                  {panelTask.blockedBy.length > 0 && (
                    <div className="mt-2.5 flex flex-col gap-1">
                      <span className="text-[11px] font-semibold text-cw-secondary">Waits for</span>
                      {panelTask.blockedBy.map((id) => {
                        const open = openCardTitles.has(id)
                        const title = openCardTitles.get(id) ?? allCardTitles.get(id) ?? id
                        return (
                          <span key={id} className="flex items-center gap-1.5 text-[11px] text-cw-text">
                            <span className={cn("min-w-0 truncate", !open && "text-cw-placeholder line-through")}>{title}</span>
                            <button
                              type="button"
                              title="Stop waiting for this card"
                              onClick={() =>
                                void api
                                  .updateTask(panelTask.id, { blockedBy: panelTask.blockedBy.filter((b) => b !== id) })
                                  .then(() => refreshState())
                              }
                              className="shrink-0 text-cw-placeholder hover:text-[#b25959]"
                            >
                              ×
                            </button>
                          </span>
                        )
                      })}
                    </div>
                  )}
                </div>

                <div className="shrink-0 border-b border-cw-border p-4">
                  <p className="mb-2 text-[13px] font-bold text-cw-text">Members</p>
                  <div className="flex items-center gap-2">
                    {panelAssignees.length > 0 ? (
                      panelAssignees.map((member) => (
                        <div key={member.id} className="flex items-center gap-1.5" title={member.name}>
                          <Avatar initials={member.initials} tone={member.tone} size={24} />
                        </div>
                      ))
                    ) : (
                      <span className="text-[11px] text-cw-placeholder">Nobody assigned yet</span>
                    )}
                  </div>
                </div>

                <RunsBlock runs={runs} byId={byId} />

                <div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
                  <div className="flex shrink-0 items-center justify-between">
                    <p className="text-[13px] font-bold text-cw-text">Task chat</p>
                    <div className="flex items-center gap-1.5">
                      <Icon src="/icons/avatar.svg" size={18} />
                      <span className="text-[10px] text-cw-secondary">
                        {Math.max(participants.size, 1)} participants
                      </span>
                    </div>
                  </div>

                  <div className="cw-scrollbar flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto">
                    {messages.length > 0 ? (
                      messages.map((message) => {
                        if (message.kind === "system") {
                          return (
                            <p
                              key={message.id}
                              className="px-2 text-center text-[10px] leading-[1.4] text-cw-placeholder"
                            >
                              {message.text} · {formatTime(message.createdAt)}
                            </p>
                          )
                        }
                        const author = byId.get(message.authorId)
                        return (
                          <div key={message.id} className="flex items-end gap-2">
                            <Avatar
                              initials={author?.initials ?? "?"}
                              tone={author?.tone ?? "amber"}
                              size={24}
                              title={author?.name}
                            />
                            <div className="flex min-w-0 flex-1 flex-col gap-1">
                              <div className="rounded-md border border-cw-border bg-white px-2.5 py-2">
                                <p className="whitespace-pre-line text-[11px] leading-[1.35] text-cw-text">
                                  {renderRichText(message.text, byHandle)}
                                </p>
                              </div>
                              <p className="text-[9px] text-cw-placeholder">
                                {author?.name ?? message.authorId} · {formatTime(message.createdAt)}
                              </p>
                            </div>
                          </div>
                        )
                      })
                    ) : (
                      <p className="text-[11px] text-cw-placeholder">
                        No messages yet for this task. Mention @architect or @coder to bring them in.
                      </p>
                    )}
                    <div ref={chatEndRef} />
                  </div>

                  <form
                    className="relative flex shrink-0 items-center gap-2"
                    onSubmit={(event) => {
                      event.preventDefault()
                      if (filteredMentions.length > 0) {
                        insertMention(filteredMentions[Math.min(mentionIndex, filteredMentions.length - 1)])
                        return
                      }
                      void sendMessage()
                    }}
                  >
                    {filteredMentions.length > 0 && (
                      <div className="absolute bottom-full left-0 z-20 mb-2 w-full overflow-hidden rounded-lg border border-cw-border bg-white shadow-[0_8px_24px_rgba(0,0,0,0.08)]">
                        <p className="border-b border-cw-border px-3 py-2 text-[10px] font-semibold uppercase tracking-wide text-cw-placeholder">
                          Mention someone
                        </p>
                        <ul className="max-h-40 overflow-y-auto py-1">
                          {filteredMentions.map((member, index) => (
                            <li key={member.id}>
                              <button
                                type="button"
                                onMouseDown={(event) => {
                                  event.preventDefault()
                                  insertMention(member)
                                }}
                                className={cn(
                                  "flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-[#fff8e9]",
                                  index === mentionIndex && "bg-[#fff8e9]"
                                )}
                              >
                                <Avatar initials={member.initials} tone={member.tone} size={22} />
                                <span className="min-w-0 flex-1">
                                  <span className="block truncate text-[12px] font-semibold text-cw-text">
                                    {member.name}
                                  </span>
                                  <span className="block text-[10px] text-cw-placeholder">@{member.handle}</span>
                                </span>
                              </button>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                    <input
                      value={draftMessage}
                      onChange={(event) => {
                        setDraftMessage(event.target.value)
                        setMentionIndex(0)
                      }}
                      onPaste={(event) =>
                        handleImagePaste(event, setDraftMessage, (message) => setLoadError(message))
                      }
                      onKeyDown={(event) => {
                        if (filteredMentions.length === 0) return
                        if (event.key === "ArrowDown") {
                          event.preventDefault()
                          setMentionIndex((index) => (index + 1) % filteredMentions.length)
                        } else if (event.key === "ArrowUp") {
                          event.preventDefault()
                          setMentionIndex((index) => (index - 1 + filteredMentions.length) % filteredMentions.length)
                        } else if (event.key === "Escape") {
                          event.preventDefault()
                          setDraftMessage((prev) =>
                            prev.replace(/(?:^|\s)@[\w]*$/, (match) => (match.startsWith(" ") ? " " : ""))
                          )
                        }
                      }}
                      className="min-h-[34px] min-w-0 flex-1 rounded-md border border-cw-border bg-white px-2.5 py-[9px] text-[11px] text-cw-text outline-none placeholder:text-cw-placeholder focus:border-cw-accent"
                      placeholder="Write a message… use @ to mention"
                    />
                    <button
                      type="submit"
                      disabled={!draftMessage.trim() || sending}
                      className="rounded-md bg-[#f2a000] px-3 py-[9px] text-[11px] font-bold text-white hover:bg-[#d99000] disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      Send
                    </button>
                  </form>
                </div>
              </div>
            </aside>
          )}
        </div>
      </div>

      {modal && activeBoard && (
        <TaskModal
          key={modal.mode === "edit" ? `edit-${modal.task.id}` : `create-${modal.columnId ?? ""}`}
          state={modal}
          board={activeBoard}
          members={members}
          onClose={() => setModal(null)}
          onTaskSaved={(task) => void onTaskSaved(task)}
          onTaskDeleted={() => void onTaskDeleted()}
          onCreateBoard={openNewBoard}
        />
      )}
      {boardDialog?.mode === "edit" && (
        <BoardEditModal
          key={boardDialog.board.id}
          board={boardDialog.board}
          members={members}
          onClose={() => setBoardDialog(null)}
          onSaved={() => {
            setBoardDialog(null)
            void refreshState()
          }}
        />
      )}
      {boardDialog?.mode === "create" && (
        <BoardEditModal
          key="new-board"
          board={null}
          members={members}
          onClose={() => setBoardDialog(null)}
          onSaved={(board) => void onBoardCreated(board)}
        />
      )}
      {me && me.name === "" && <WelcomeModal onDone={() => void refreshState()} />}
      {boardDialog?.mode === "delete" && (
        <ConfirmDialog
          title={`Delete “${boardDialog.board.name}”?`}
          text={`${boardDialog.board.columns.reduce((n, column) => n + column.tasks.length, 0)} task(s) with their chat and agent runs will be removed. This cannot be undone.`}
          confirmLabel="Delete board"
          busy={boardBusy}
          error={boardError}
          onCancel={() => (boardBusy ? undefined : setBoardDialog(null))}
          onConfirm={() => void confirmDeleteBoard()}
        />
      )}
      {archiveColumn && (
        <ConfirmDialog
          title={`Archive all cards in “${archiveColumn.title}”?`}
          text={`${archiveColumn.cards.length} card(s) leave the board but stay in the archive — you can restore them any time from “Archive” in the sidebar.`}
          confirmLabel="Archive cards"
          tone="accent"
          busy={archiveBusy}
          onCancel={() => (archiveBusy ? undefined : setArchiveColumn(null))}
          onConfirm={() => void confirmArchiveColumn()}
        />
      )}
      {deleteColumn && (
        <ConfirmDialog
          title={`Delete list “${deleteColumn.title}”?`}
          text={`It still has ${deleteColumn.cards.length} card(s). Archive them to keep them under “Archive” in the sidebar, or delete them with their chat and agent runs — that cannot be undone.`}
          confirmLabel="Delete cards"
          busy={deleteColumnBusy}
          error={deleteColumnError}
          alternative={{ label: "Archive cards", onClick: () => void confirmDeleteColumn("archive") }}
          onCancel={() => (deleteColumnBusy ? undefined : setDeleteColumn(null))}
          onConfirm={() => void confirmDeleteColumn("delete")}
        />
      )}
      {settingsOpen && me && (
        <SettingsModal me={me} onClose={() => setSettingsOpen(false)} onSaved={() => void refreshState()} />
      )}
      {agentDialog && (
        <AgentEditModal
          agent={agentDialog.agent}
          worker={worker}
          onClose={() => setAgentDialog(null)}
          onSaved={() => {
            setAgentDialog(null)
            void refreshState()
          }}
        />
      )}
    </div>
  )
}
