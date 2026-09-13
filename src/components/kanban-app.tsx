"use client"

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react"
import {
  DndContext,
  DragOverlay,
  PointerSensor,
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
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import { AVATAR_STYLES, PRIORITY_STYLES } from "@/lib/kanban-data"
import { api } from "@/lib/api"
import { PRIORITIES } from "@/lib/types"
import type {
  AvatarTone,
  Board,
  BoardState,
  ColumnRole,
  Member,
  Message,
  Priority,
  Run,
  Task,
  TaskThread,
} from "@/lib/types"
import { cn } from "@/lib/utils"

// ---------------------------------------------------------------------------
// View types — what the board renders. Tasks come from the API; assignees are
// resolved to members here so the card components stay dumb.

type CardView = Task & { assignees: Member[]; selected: boolean }

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
const collisionDetection: CollisionDetection = (args) => {
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
      : agent?.agentRole === "coder"
        ? "working"
        : "thinking"
  return `${shortName(agent)} · ${verb}`
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

function SettingsModal({ me, onClose }: { me: Member; onClose: () => void }) {
  const [activeTab, setActiveTab] = useState<"profile" | "workspace" | "notifications">("profile")
  const [displayName, setDisplayName] = useState(me.name)
  const [handle, setHandle] = useState(me.handle)
  const [workspaceName, setWorkspaceName] = useState("Creative Space")
  const [emailAlerts, setEmailAlerts] = useState(true)
  const [mentionAlerts, setMentionAlerts] = useState(true)

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
                  Members, boards, and permissions live in data/board.db next to the project. Profile
                  settings are not saved yet.
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
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-cw-border bg-white px-4 py-2.5 text-[13px] font-bold text-cw-text hover:bg-[#faf9f7]"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md bg-cw-accent px-4 py-2.5 text-[13px] font-bold text-white hover:bg-[#d99c1c]"
          >
            Save changes
          </button>
        </div>
      </div>
    </div>
  )
}

function PriorityPill({ priority, large = false }: { priority: Priority; large?: boolean }) {
  const style = PRIORITY_STYLES[priority]
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full font-bold leading-none",
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
        "inline-flex items-center gap-1.5 rounded-full font-semibold leading-none",
        large ? "h-[26px] px-3 text-[10px]" : "h-[22px] px-2 text-[9px]"
      )}
      style={{ backgroundColor: style.bg, color: style.text }}
      title={card.agentStatus.trigger}
    >
      <span
        className={cn("inline-block size-1.5 rounded-full", card.agentStatus.status === "running" && "cw-pulse")}
        style={{ backgroundColor: style.text }}
      />
      {label}
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

function BoardEditModal({
  board,
  onClose,
  onSaved,
}: {
  board: Board
  onClose: () => void
  onSaved: (board: Board) => void
}) {
  const [name, setName] = useState(board.name)
  const [repoPath, setRepoPath] = useState(board.repoPath ?? "")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const canSave = name.trim().length > 0 && !busy

  const submit = async () => {
    if (!canSave) return
    setBusy(true)
    setError(null)
    try {
      onSaved(await api.updateBoard(board.id, { name: name.trim(), repoPath: repoPath.trim() }))
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the board")
      setBusy(false)
    }
  }

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
            Board details
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
            <input autoFocus value={name} onChange={(event) => setName(event.target.value)} className={inputClass} />
          </label>
          <label className="flex w-full flex-col gap-1.5">
            <span className="text-xs font-semibold text-cw-secondary">Repository folder</span>
            <input
              value={repoPath}
              onChange={(event) => setRepoPath(event.target.value)}
              className={inputClass}
              placeholder="Leave empty to use this project"
            />
            <span className="text-[11px] leading-[1.4] text-cw-placeholder">
              Where the Coder works and the Architect reads. Absolute path on this Mac.
            </span>
          </label>
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
            {busy ? "Saving…" : "Save changes"}
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
  onCancel,
  onConfirm,
}: {
  title: string
  text: string
  confirmLabel: string
  busy?: boolean
  error?: string | null
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
          <button
            type="button"
            autoFocus
            disabled={busy}
            onClick={onConfirm}
            className="rounded-md bg-[#b25959] px-4 py-2.5 text-[13px] font-bold text-white hover:bg-[#9d4b4b] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? "Deleting…" : confirmLabel}
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
        <p className="cw-line-clamp-2 w-full text-xs leading-[1.3] text-[#6e6e69]">{card.description}</p>
      )}
      <div className="flex w-full items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <PriorityPill priority={card.priority} />
          <AgentBadge card={card} byId={byId} />
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
}

function columnClass(columnIndex: number) {
  return cn(
    "relative flex min-h-0 min-w-0 flex-col",
    "min-w-[300px] flex-1",
    columnIndex > 0 && "border-l border-[#d9d9d7] pl-4",
    "pr-4"
  )
}

function ColumnHeader({
  column,
  onRename,
  onDelete,
}: {
  column: ColumnView
  onRename: (title: string) => Promise<void>
  onDelete: () => Promise<void>
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
    <div ref={rootRef} className="group/col mb-2.5 shrink-0 select-none">
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
                "flex size-6 items-center justify-center rounded-md text-cw-secondary transition-opacity hover:bg-[#eceae6] hover:text-cw-text",
                open ? "bg-[#eceae6] opacity-100" : "opacity-0 group-hover/col:opacity-100 focus-visible:opacity-100"
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
    <div className="flex w-[300px] shrink-0 flex-col border-l border-[#d9d9d7] pl-4">
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
      className="flex items-center gap-1.5 text-xs font-semibold text-cw-text hover:text-cw-accent-strong"
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
}: ColumnProps) {
  return (
    <div className={columnClass(columnIndex)}>
      <ColumnHeader
        column={column}
        onRename={(title) => onRenameColumn(column.id, title)}
        onDelete={() => onDeleteColumn(column.id)}
      />
      <div className="cw-scrollbar flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto rounded-lg pb-16">
        {column.cards.map((card) => (
          <StaticTaskCard key={card.id} card={card} byId={byId} onSelect={onSelectCard} />
        ))}
        <AddCardButton onClick={() => onAddCard(column.id)} />
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
}: ColumnProps) {
  const { setNodeRef, isOver } = useDroppable({ id: column.id })
  const cardIds = useMemo(() => column.cards.map((card) => card.id), [column.cards])

  return (
    <div className={columnClass(columnIndex)}>
      <ColumnHeader
        column={column}
        onRename={(title) => onRenameColumn(column.id, title)}
        onDelete={() => onDeleteColumn(column.id)}
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
        <AddCardButton onClick={() => onAddCard(column.id)} />
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
  onBoardCreated,
}: {
  state: ModalState
  board: Board
  members: Member[]
  onClose: () => void
  onTaskSaved: (task: Task) => void
  onTaskDeleted: (taskId: string) => void
  onBoardCreated: (board: Board) => void
}) {
  const editing = modal.mode === "edit" ? modal.task : null
  const [type, setType] = useState<"task" | "board">("task")
  const [title, setTitle] = useState(editing?.title ?? "")
  const [description, setDescription] = useState(editing?.description ?? "")
  const [priority, setPriority] = useState<Priority>(editing?.priority ?? "MEDIUM")
  const [columnId, setColumnId] = useState(
    editing?.columnId ?? (modal.mode === "create" ? modal.columnId : undefined) ?? board.columns[0]?.id ?? ""
  )
  const [assigneeIds, setAssigneeIds] = useState<string[]>(editing?.assigneeIds ?? [])
  const [boardName, setBoardName] = useState("")
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
      if (type === "board") {
        const created = await api.createBoard({ name: boardName })
        onBoardCreated(created)
        return
      }
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

  const canSubmit = type === "board" ? boardName.trim().length > 0 : title.trim().length > 0

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
            {editing ? "Edit task" : type === "board" ? "Create new board" : "Create new task"}
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
                  onClick={() => setType(option)}
                  className={cn(
                    "flex flex-1 items-center justify-center rounded-lg border px-3 py-2.5 text-[13px]",
                    type === option
                      ? "border-cw-accent bg-cw-warm font-bold text-cw-accent"
                      : "border-cw-border bg-white font-semibold text-cw-secondary hover:bg-[#faf9f7]"
                  )}
                >
                  {option === "task" ? "Task" : "Board"}
                </button>
              ))}
            </div>
          )}

          {type === "board" && !editing ? (
            <>
              <label className="flex w-full flex-col gap-1.5">
                <span className="text-xs font-semibold text-cw-secondary">Board name</span>
                <input
                  autoFocus
                  value={boardName}
                  onChange={(event) => setBoardName(event.target.value)}
                  className={inputClass}
                  placeholder="e.g. Merge game UI"
                />
              </label>
              <p className="text-[12px] leading-[1.4] text-cw-secondary">
                New boards get Backlog → Ready → In progress → Review → Done and the three of us as members.
              </p>
            </>
          ) : (
            <>
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
            </>
          )}

          {error && <p className="text-[12px] font-medium text-[#b25959]">{error}</p>}
        </form>

        <div className="flex items-center justify-between border-t border-cw-border px-5 py-4">
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
              {busy ? "Saving…" : editing ? "Save changes" : type === "board" ? "Create board" : "Create task"}
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
    if (target.closest("button, input, textarea, select, a, [role='button']")) return
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
  const [activeBoardId, setActiveBoardId] = useState<string | null>(null)
  const [selection, setSelection] = useState<Record<string, Selection>>({})
  const [thread, setThread] = useState<TaskThread | null>(null)
  const [search, setSearch] = useState("")
  const [modal, setModal] = useState<ModalState | null>(null)
  const [boardDialog, setBoardDialog] = useState<{ mode: "edit" | "delete"; board: Board } | null>(null)
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
      let payload: { type?: string; scope?: string; taskId?: string } = {}
      try {
        payload = JSON.parse(event.data)
      } catch {
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
    return () => {
      if (timer) clearTimeout(timer)
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
    return null
  }, [activeBoard, selectedId])

  const openTaskId = panelOpen && selectedTask ? selectedTask.id : null

  useEffect(() => {
    selectedTaskRef.current = openTaskId
    // Fetch the thread of the task that just opened (external system).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refreshThread(openTaskId)
  }, [openTaskId, refreshThread])

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
        })),
    }))
  }, [activeBoard, byId, selectedId, panelOpen, search])

  const columns = localColumns ?? serverColumns

  const boardMembers = useMemo(
    () => (activeBoard ? activeBoard.memberIds.map((id) => byId.get(id)).filter((m): m is Member => !!m) : []),
    [activeBoard, byId]
  )

  // --- drag & drop ----------------------------------------------------------

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }))

  const handleDragStart = (event: DragStartEvent) => {
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
    if (!over) return
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

    if (activeColumnId === overColumnId) {
      const cards = prev[sourceIndex].cards
      const oldIndex = cards.findIndex((card) => card.id === activeId)
      const newIndex = overId === overColumnId ? cards.length - 1 : cards.findIndex((card) => card.id === overId)
      if (oldIndex < 0 || newIndex < 0 || oldIndex === newIndex) return
      setLocalColumns(
        prev.map((column, index) =>
          index === sourceIndex ? { ...column, cards: arrayMove(cards, oldIndex, newIndex) } : column
        )
      )
      return
    }

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

  const handleDragEnd = (event: DragEndEvent) => {
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
    await refreshState()
    switchBoard(board.id)
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
      await api.deleteColumn(columnId)
      await refreshState()
    },
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
            <span className="text-[34px] font-black leading-none text-[#f2a000]">CC</span>
            <div className="flex flex-col gap-px">
              <span className="text-xs text-cw-text">Creative Space</span>
              <span className="text-[10px] text-cw-secondary">Workspace</span>
            </div>
          </div>

          <nav className="flex flex-col gap-0.5 pt-7">
            <NavItem icon="/icons/folder.svg" label="Assets" />
            <NavItem icon="/icons/users.svg" label="Members" />
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
                active={board.id === activeBoard?.id}
                onSelect={() => switchBoard(board.id)}
                onEdit={() => openBoardDialog("edit", board)}
                onDelete={() => openBoardDialog("delete", board)}
              />
            ))}
          </nav>
        </div>
      </aside>

      {/* Main */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-16 shrink-0 items-center justify-between gap-4 border-b border-cw-border bg-white px-[18px]">
          <div className="flex min-w-0 items-center gap-4">
            <p className="shrink-0 whitespace-pre text-xs text-cw-secondary">
              {`Workspace  /  ${activeBoard?.name ?? "…"}`}
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
            <button
              type="button"
              disabled={!activeBoard}
              onClick={() => setModal({ mode: "create" })}
              className="rounded-md bg-cw-accent px-4 py-2 text-[13px] font-bold text-white hover:bg-[#d99c1c] disabled:opacity-50"
            >
              + Create
            </button>
            {me && <UserMenu me={me} onOpenSettings={() => setSettingsOpen(true)} />}
          </div>
        </header>

        <div className="flex min-h-0 flex-1">
          {!state ? (
            <div className="flex min-w-0 flex-1 items-center justify-center bg-cw-bg text-xs text-cw-placeholder">
              {loadError ?? "Loading board…"}
            </div>
          ) : dndReady && activeBoard ? (
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
                {columns.map((column, columnIndex) => (
                  <SortableKanbanColumn
                    key={`${activeBoard.id}-${column.id}`}
                    column={column}
                    columnIndex={columnIndex}
                    {...columnProps}
                  />
                ))}
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
            <aside className="cw-panel-shadow relative z-10 flex w-[290px] shrink-0 flex-col overflow-hidden border-l border-cw-border bg-white">
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
                      {panelTask.description}
                    </p>
                  )}
                  <div className="flex flex-wrap items-center gap-1.5">
                    <PriorityPill priority={panelTask.priority} large />
                    <AgentBadge card={panelTask} byId={byId} large />
                  </div>
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
                            <div className="flex w-[220px] max-w-full flex-col gap-1">
                              <div className="rounded-md border border-cw-border bg-white px-2.5 py-2">
                                <p className="whitespace-pre-line text-[11px] leading-[1.35] text-cw-text">
                                  {renderMessageText(message.text, byHandle)}
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
          onBoardCreated={(board) => void onBoardCreated(board)}
        />
      )}
      {boardDialog?.mode === "edit" && (
        <BoardEditModal
          key={boardDialog.board.id}
          board={boardDialog.board}
          onClose={() => setBoardDialog(null)}
          onSaved={() => {
            setBoardDialog(null)
            void refreshState()
          }}
        />
      )}
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
      {settingsOpen && me && <SettingsModal me={me} onClose={() => setSettingsOpen(false)} />}
    </div>
  )
}
