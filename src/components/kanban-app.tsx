"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCorners,
  useDroppable,
  useSensor,
  useSensors,
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
import {
  AVATAR_STYLES,
  BOARDS,
  PRIORITY_STYLES,
  cloneColumns,
  type Assignee,
  type ChatMessage,
  type Column,
  type Priority,
  type TaskCard,
} from "@/lib/kanban-data"
import { cn } from "@/lib/utils"

type MentionUser = {
  initials: string
  tone: Assignee["tone"]
  name: string
  handle: string
}

const WORKSPACE_MEMBERS: MentionUser[] = [
  { initials: "MS", tone: "amber", name: "May Sh", handle: "may" },
  { initials: "EM", tone: "blue", name: "Emily Mitchell", handle: "emily" },
  { initials: "JK", tone: "purple", name: "Jordan Kim", handle: "jordan" },
]

function getMentionQuery(value: string): string | null {
  const match = value.match(/(?:^|\s)@([\w]*)$/)
  return match ? match[1].toLowerCase() : null
}

function renderMessageText(text: string) {
  const parts = text.split(/(@[A-Za-z][\w]*)/g)
  return parts.map((part, index) => {
    if (part.startsWith("@") && part.length > 1) {
      const handle = part.slice(1).toLowerCase()
      const member = WORKSPACE_MEMBERS.find(
        (user) =>
          user.handle === handle ||
          user.initials.toLowerCase() === handle ||
          user.name.toLowerCase().split(" ")[0] === handle
      )
      const color = member
        ? AVATAR_STYLES[member.tone].text
        : "#c48400"
      return (
        <span
          key={`${part}-${index}`}
          className="font-semibold"
          style={{ color }}
        >
          {part}
        </span>
      )
    }
    return <span key={`${part}-${index}`}>{part}</span>
  })
}

function findColumnId(columns: Column[], itemId: string): string | undefined {
  if (columns.some((column) => column.id === itemId)) {
    return itemId
  }
  return columns.find((column) =>
    column.cards.some((card) => card.id === itemId)
  )?.id
}

function findCard(columns: Column[], cardId: string): TaskCard | undefined {
  for (const column of columns) {
    const card = column.cards.find((item) => item.id === cardId)
    if (card) return card
  }
  return undefined
}

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
    <img
      src={src}
      alt={alt}
      width={size}
      height={size}
      className={cn("shrink-0", className)}
    />
  )
}

function Avatar({
  initials,
  tone,
  size = 22,
  className,
}: {
  initials: string
  tone: Assignee["tone"]
  size?: number
  className?: string
}) {
  const style = AVATAR_STYLES[tone]
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full font-bold",
        className
      )}
      style={{
        width: size,
        height: size,
        backgroundColor: style.bg,
        color: style.text,
        fontSize: size <= 22 ? 9 : size <= 24 ? 9 : 12,
      }}
    >
      {initials}
    </span>
  )
}

function UserMenu({ onOpenSettings }: { onOpenSettings: () => void }) {
  const [open, setOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) {
        setOpen(false)
      }
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
        <Avatar initials="MS" tone="amber" size={32} />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute top-full right-0 z-40 mt-2 w-[220px] overflow-hidden rounded-xl border border-cw-border bg-white shadow-[0_12px_32px_rgba(0,0,0,0.12)]"
        >
          <div className="flex items-center gap-2.5 border-b border-cw-border px-3 py-3">
            <Avatar initials="MS" tone="amber" size={36} />
            <div className="min-w-0">
              <p className="truncate text-[13px] font-semibold text-cw-text">
                May Sh
              </p>
              <p className="truncate text-[11px] text-cw-placeholder">
                may@creativewizards.io
              </p>
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

function SettingsModal({ onClose }: { onClose: () => void }) {
  const [activeTab, setActiveTab] = useState<"profile" | "workspace" | "notifications">(
    "profile"
  )
  const [displayName, setDisplayName] = useState("May Sh")
  const [email, setEmail] = useState("may@creativewizards.io")
  const [workspaceName, setWorkspaceName] = useState("Creative Wizards")
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
                  activeTab === id
                    ? "bg-white text-cw-text shadow-sm"
                    : "text-cw-secondary hover:bg-white/70"
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
                  <Avatar initials="MS" tone="amber" size={48} />
                  <div>
                    <p className="text-[13px] font-semibold text-cw-text">
                      May Sh
                    </p>
                    <p className="text-[11px] text-cw-placeholder">
                      Avatar colors follow your initials
                    </p>
                  </div>
                </div>
                <label className="flex w-full flex-col gap-1.5">
                  <span className="text-xs font-semibold text-cw-secondary">
                    Display name
                  </span>
                  <input
                    value={displayName}
                    onChange={(event) => setDisplayName(event.target.value)}
                    className="w-full rounded-lg border border-cw-border bg-white px-3 py-2.5 text-[13px] text-cw-text outline-none focus:border-cw-accent"
                  />
                </label>
                <label className="flex w-full flex-col gap-1.5">
                  <span className="text-xs font-semibold text-cw-secondary">
                    Email
                  </span>
                  <input
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    className="w-full rounded-lg border border-cw-border bg-white px-3 py-2.5 text-[13px] text-cw-text outline-none focus:border-cw-accent"
                  />
                </label>
              </>
            )}

            {activeTab === "workspace" && (
              <>
                <label className="flex w-full flex-col gap-1.5">
                  <span className="text-xs font-semibold text-cw-secondary">
                    Workspace name
                  </span>
                  <input
                    value={workspaceName}
                    onChange={(event) => setWorkspaceName(event.target.value)}
                    className="w-full rounded-lg border border-cw-border bg-white px-3 py-2.5 text-[13px] text-cw-text outline-none focus:border-cw-accent"
                  />
                </label>
                <p className="text-[12px] leading-[1.4] text-cw-secondary">
                  Members, boards, and permissions for Creative Wizards live
                  here. Changes stay local in this demo.
                </p>
              </>
            )}

            {activeTab === "notifications" && (
              <>
                <label className="flex items-center justify-between gap-3 rounded-lg border border-cw-border px-3 py-3">
                  <span>
                    <span className="block text-[13px] font-semibold text-cw-text">
                      Email alerts
                    </span>
                    <span className="block text-[11px] text-cw-placeholder">
                      Digest for board activity
                    </span>
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
                    <span className="block text-[13px] font-semibold text-cw-text">
                      Mention notifications
                    </span>
                    <span className="block text-[11px] text-cw-placeholder">
                      When someone tags you in task chat
                    </span>
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

function PriorityPill({
  priority,
  large = false,
}: {
  priority: Priority
  large?: boolean
}) {
  const style = PRIORITY_STYLES[priority]
  return (
    <span
      className={cn(
        "inline-flex rounded-full font-bold",
        large ? "px-3 py-[5px] text-[10px]" : "px-2.5 py-1 text-[10px]"
      )}
      style={{ backgroundColor: style.bg, color: style.text }}
    >
      {priority}
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
        active
          ? "border-l-[3px] border-[#f2a000] bg-[#fff8e9] font-semibold pl-[15px]"
          : "hover:bg-[#faf9f7]"
      )}
    >
      <Icon src={icon} size={16} />
      <span>{label}</span>
    </button>
  )
}

function TaskCardContent({
  card,
  dragging = false,
}: {
  card: TaskCard
  dragging?: boolean
}) {
  const hasStats =
    typeof card.comments === "number" || typeof card.attachments === "number"

  return (
    <div
      className={cn(
        "cw-card-shadow flex w-full flex-col gap-[9px] rounded-[10px] border-2 p-[14px] text-left",
        card.selected
          ? "border-[#ed9e1c] bg-cw-active-card"
          : "border-cw-border bg-white",
        dragging && "shadow-[0_8px_24px_rgba(0,0,0,0.12)]"
      )}
    >
      <h3 className="w-full text-sm font-semibold text-cw-text">{card.title}</h3>
      <p className="cw-line-clamp-2 w-full text-xs leading-[1.3] text-[#6e6e69]">
        {card.description}
      </p>
      <div className="flex w-full items-center justify-between">
        <PriorityPill priority={card.priority} />
        <div className="flex items-center gap-2">
          {hasStats && (
            <>
              {typeof card.comments === "number" && (
                <span className="flex items-center gap-[3px] text-[11px] font-medium text-[#666]">
                  <Icon src="/icons/comment.svg" size={13} />
                  {card.comments}
                </span>
              )}
              {typeof card.comments === "number" &&
                typeof card.attachments === "number" && (
                  <span className="h-3 w-px bg-[#d1d1d1]" />
                )}
              {typeof card.attachments === "number" && (
                <span className="flex items-center gap-[3px] text-[11px] font-medium text-[#666]">
                    <Icon src="/icons/paperclip.svg" size={13} />
                  {card.attachments}
                </span>
              )}
              <span className="h-3 w-px bg-[#d1d1d1]" />
            </>
          )}
          <div className="flex items-start">
            {card.assignees.map((person, index) => (
              <span
                key={`${card.id}-${person.initials}-${index}`}
                className={cn(index < card.assignees.length - 1 && "-mr-[5px]")}
              >
                <Avatar initials={person.initials} tone={person.tone} />
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
  onSelect,
}: {
  card: TaskCard
  onSelect: (id: string) => void
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(card.id)}
      className="w-full cursor-grab touch-none text-left active:cursor-grabbing hover:shadow-[0_4px_14px_rgba(0,0,0,0.08)]"
    >
      <TaskCardContent card={card} />
    </button>
  )
}

function SortableTaskCard({
  card,
  onSelect,
}: {
  card: TaskCard
  onSelect: (id: string) => void
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: card.id })

  return (
    <button
      ref={setNodeRef}
      type="button"
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
      }}
      {...attributes}
      {...listeners}
      onClick={() => onSelect(card.id)}
      className={cn(
        "w-full cursor-grab touch-none text-left active:cursor-grabbing",
        "hover:shadow-[0_4px_14px_rgba(0,0,0,0.08)]",
        isDragging && "z-10 opacity-40"
      )}
    >
      <TaskCardContent card={card} />
    </button>
  )
}

function StaticKanbanColumn({
  column,
  columnIndex,
  columnCount,
  onSelectCard,
  onAddCard,
}: {
  column: Column
  columnIndex: number
  columnCount: number
  onSelectCard: (id: string) => void
  onAddCard: () => void
}) {
  return (
    <div
      className={cn(
        "relative flex min-h-0 min-w-0 flex-1 flex-col",
        columnIndex > 0 && "border-l border-[#d9d9d7] pl-4",
        columnIndex < columnCount - 1 && "pr-4"
      )}
    >
      <div className="mb-2.5 flex shrink-0 items-start justify-between">
        <h2 className="text-lg font-bold text-cw-text">{column.title}</h2>
        <span className="text-xs text-cw-placeholder">{column.cards.length}</span>
      </div>

      <div className="cw-scrollbar flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto rounded-lg pb-16">
        {column.cards.map((card) => (
          <StaticTaskCard
            key={card.id}
            card={card}
            onSelect={onSelectCard}
          />
        ))}
        <button
          type="button"
          onClick={onAddCard}
          className="flex items-center gap-1.5 text-xs font-semibold text-cw-text hover:text-cw-accent-strong"
        >
          <Icon src="/icons/plus.svg" size={12} />
          Add a card
        </button>
      </div>

      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-20 bg-gradient-to-b from-transparent to-cw-bg" />
    </div>
  )
}

function SortableKanbanColumn({
  column,
  columnIndex,
  columnCount,
  onSelectCard,
  onAddCard,
}: {
  column: Column
  columnIndex: number
  columnCount: number
  onSelectCard: (id: string) => void
  onAddCard: () => void
}) {
  const { setNodeRef, isOver } = useDroppable({ id: column.id })
  const cardIds = useMemo(
    () => column.cards.map((card) => card.id),
    [column.cards]
  )

  return (
    <div
      className={cn(
        "relative flex min-h-0 min-w-0 flex-1 flex-col",
        columnIndex > 0 && "border-l border-[#d9d9d7] pl-4",
        columnIndex < columnCount - 1 && "pr-4"
      )}
    >
      <div className="mb-2.5 flex shrink-0 items-start justify-between">
        <h2 className="text-lg font-bold text-cw-text">{column.title}</h2>
        <span className="text-xs text-cw-placeholder">{column.cards.length}</span>
      </div>

      <div
        ref={setNodeRef}
        className={cn(
          "cw-scrollbar flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto rounded-lg pb-16 transition-colors",
          isOver && "bg-[#f3f1ec]/60"
        )}
      >
        <SortableContext items={cardIds} strategy={verticalListSortingStrategy}>
          {column.cards.map((card) => (
            <SortableTaskCard
              key={card.id}
              card={card}
              onSelect={onSelectCard}
            />
          ))}
        </SortableContext>
        <button
          type="button"
          onClick={onAddCard}
          className="flex items-center gap-1.5 text-xs font-semibold text-cw-text hover:text-cw-accent-strong"
        >
          <Icon src="/icons/plus.svg" size={12} />
          Add a card
        </button>
      </div>

      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-20 bg-gradient-to-b from-transparent to-cw-bg" />
    </div>
  )
}

function CreateTaskModal({ onClose }: { onClose: () => void }) {
  const [type, setType] = useState<"task" | "board">("task")

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-[4px]"
      role="dialog"
      aria-modal="true"
      aria-labelledby="create-task-title"
      onClick={onClose}
    >
      <div
        className="cw-modal-shadow flex w-[480px] max-w-[calc(100vw-32px)] flex-col overflow-hidden rounded-xl border border-cw-border bg-white"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-cw-border py-4 pl-5 pr-4">
          <h2 id="create-task-title" className="text-lg font-bold text-cw-text">
            Create new task
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

        <div className="flex flex-col gap-4 p-5">
          <div className="flex gap-1">
            <button
              type="button"
              onClick={() => setType("task")}
              className={cn(
                "flex flex-1 items-center justify-center rounded-lg border px-3 py-2.5 text-[13px]",
                type === "task"
                  ? "border-cw-accent bg-cw-warm font-bold text-cw-accent"
                  : "border-cw-border bg-white font-semibold text-cw-secondary hover:bg-[#faf9f7]"
              )}
            >
              Task
            </button>
            <button
              type="button"
              onClick={() => setType("board")}
              className={cn(
                "flex flex-1 items-center justify-center rounded-lg border px-3 py-2.5 text-[13px]",
                type === "board"
                  ? "border-cw-accent bg-cw-warm font-bold text-cw-accent"
                  : "border-cw-border bg-white font-semibold text-cw-secondary hover:bg-[#faf9f7]"
              )}
            >
              Board
            </button>
          </div>

          <label className="flex w-full flex-col gap-1.5">
            <span className="text-xs font-semibold text-cw-secondary">
              Task title
            </span>
            <input
              className="w-full rounded-lg border border-cw-border bg-white px-3 py-2.5 text-[13px] text-cw-text placeholder:text-cw-placeholder outline-none focus:border-cw-accent"
              placeholder="Enter task title"
            />
          </label>

          <label className="flex w-full flex-col gap-1.5">
            <span className="text-xs font-semibold text-cw-secondary">
              Description
            </span>
            <textarea
              className="h-24 w-full resize-none rounded-lg border border-cw-border bg-white px-3 py-2.5 text-[13px] leading-[1.4] text-cw-text placeholder:text-cw-placeholder outline-none focus:border-cw-accent"
              placeholder="Add a brief description of the task..."
            />
          </label>

          <label className="flex w-full flex-col gap-1.5">
            <span className="text-xs font-semibold text-cw-secondary">
              Priority
            </span>
            <div className="relative">
              <select
                defaultValue="Medium"
                className="w-full appearance-none rounded-lg border border-cw-border bg-white px-3 py-2.5 pr-10 text-[13px] text-cw-text outline-none focus:border-cw-accent"
              >
                <option>New</option>
                <option>Low</option>
                <option>Medium</option>
                <option>High</option>
              </select>
              <Icon
                src="/icons/chevron-down.svg"
                size={16}
                className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2"
              />
            </div>
          </label>

          <label className="flex w-full flex-col gap-1.5">
            <span className="text-xs font-semibold text-cw-secondary">
              Status / Column
            </span>
            <div className="relative">
              <select
                defaultValue="Backlog"
                className="w-full appearance-none rounded-lg border border-cw-border bg-white px-3 py-2.5 pr-10 text-[13px] text-cw-text outline-none focus:border-cw-accent"
              >
                <option>Backlog</option>
                <option>Design</option>
                <option>To Do</option>
              </select>
              <Icon
                src="/icons/chevron-down.svg"
                size={16}
                className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2"
              />
            </div>
          </label>

          <div className="flex w-full flex-col gap-1.5">
            <span className="text-xs font-semibold text-cw-secondary">
              Assignees
            </span>
            <div className="flex items-center gap-2 rounded-lg border border-cw-border bg-white px-3 py-2.5">
              <Avatar initials="MS" tone="amber" size={24} />
              <Avatar initials="EM" tone="blue" size={24} />
              <span className="text-[13px] text-cw-placeholder">
                Add assignees
              </span>
            </div>
          </div>
        </div>

        <div className="flex items-center justify-between border-t border-cw-border px-5 py-4">
          <button
            type="button"
            disabled
            className="rounded-md border border-[#e3e0de] px-4 py-2.5 text-[13px] font-bold text-[#b25959] opacity-50"
          >
            Delete
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
              onClick={onClose}
              className="rounded-md bg-cw-accent px-4 py-2.5 text-[13px] font-bold text-white hover:bg-[#d99c1c]"
            >
              Create task
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}


function formatChatTime(date = new Date()) {
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
}

function seedChatMessages(): Record<string, ChatMessage[]> {
  const seeded: Record<string, ChatMessage[]> = {}
  for (const board of BOARDS) {
    if (!board.detailCardId || !board.detail) continue
    seeded[board.detailCardId] = board.detail.messages.map((message, index) => ({
      id: `${board.detailCardId}-seed-${index}`,
      initials: message.initials,
      tone: message.tone,
      text: message.text,
      meta: message.meta,
    }))
  }
  return seeded
}

type BoardRuntimeState = {
  columns: Column[]
  selectedId: string | null
  panelOpen: boolean
}

function createInitialBoardStates(): Record<string, BoardRuntimeState> {
  return Object.fromEntries(
    BOARDS.map((board) => [
      board.id,
      {
        columns: cloneColumns(board.columns),
        selectedId: board.defaultSelectedId,
        panelOpen: board.defaultSelectedId != null && board.detail != null,
      },
    ])
  )
}

export function KanbanApp() {
  const [activeBoardId, setActiveBoardId] = useState(BOARDS[0].id)
  const [boardStates, setBoardStates] = useState(createInitialBoardStates)
  const [modalOpen, setModalOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [activeCard, setActiveCard] = useState<TaskCard | null>(null)
  const [activeCardWidth, setActiveCardWidth] = useState<number | null>(null)
  // Gate @dnd-kit until after mount so SSR HTML matches the first client paint
  // (dnd-kit accessibility IDs like DndDescribedBy-* differ across SSR/client).
  const [dndReady, setDndReady] = useState(false)
  const [chatByCardId, setChatByCardId] = useState(seedChatMessages)
  const [draftMessage, setDraftMessage] = useState("")
  const [mentionIndex, setMentionIndex] = useState(0)
  const chatEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setDndReady(true)
  }, [])

  const activeBoard =
    BOARDS.find((board) => board.id === activeBoardId) ?? BOARDS[0]
  const { columns, selectedId, panelOpen } = boardStates[activeBoard.id]

  const setColumns = (
    updater: Column[] | ((prev: Column[]) => Column[])
  ) => {
    setBoardStates((prev) => {
      const current = prev[activeBoard.id]
      const nextColumns =
        typeof updater === "function" ? updater(current.columns) : updater
      return {
        ...prev,
        [activeBoard.id]: { ...current, columns: nextColumns },
      }
    })
  }

  const setSelectedId = (id: string | null) => {
    setBoardStates((prev) => ({
      ...prev,
      [activeBoard.id]: { ...prev[activeBoard.id], selectedId: id },
    }))
  }

  const setPanelOpen = (open: boolean) => {
    setBoardStates((prev) => ({
      ...prev,
      [activeBoard.id]: { ...prev[activeBoard.id], panelOpen: open },
    }))
  }

  const switchBoard = (boardId: string) => {
    if (boardId === activeBoardId) return
    setActiveCard(null)
    setActiveCardWidth(null)
    setActiveBoardId(boardId)
  }

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 8 },
    })
  )

  const boardColumns = useMemo(
    () =>
      columns.map((column) => ({
        ...column,
        cards: column.cards.map((card) => ({
          ...card,
          selected: card.id === selectedId && panelOpen,
        })),
      })),
    [columns, selectedId, panelOpen]
  )

  const handleDragStart = (event: DragStartEvent) => {
    setActiveCard(findCard(columns, String(event.active.id)) ?? null)

    // active.rect.current.initial is still null at onDragStart (filled in a
    // later layout effect), so measure the activator node instead.
    const target =
      event.activatorEvent.target instanceof Element
        ? event.activatorEvent.target.closest("button")
        : null
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

    setColumns((prev) => {
      const activeColumnId = findColumnId(prev, activeId)
      const overColumnId = findColumnId(prev, overId)
      if (!activeColumnId || !overColumnId) return prev

      const sourceIndex = prev.findIndex((column) => column.id === activeColumnId)
      const destIndex = prev.findIndex((column) => column.id === overColumnId)
      if (sourceIndex < 0 || destIndex < 0) return prev

      if (activeColumnId === overColumnId) {
        const cards = prev[sourceIndex].cards
        const oldIndex = cards.findIndex((card) => card.id === activeId)
        const newIndex =
          overId === overColumnId
            ? cards.length - 1
            : cards.findIndex((card) => card.id === overId)
        if (oldIndex < 0 || newIndex < 0 || oldIndex === newIndex) return prev
        return prev.map((column, index) =>
          index === sourceIndex
            ? { ...column, cards: arrayMove(cards, oldIndex, newIndex) }
            : column
        )
      }

      const sourceCards = [...prev[sourceIndex].cards]
      const destCards = [...prev[destIndex].cards]
      const cardIndex = sourceCards.findIndex((card) => card.id === activeId)
      if (cardIndex < 0) return prev

      const [moved] = sourceCards.splice(cardIndex, 1)
      const overCardIndex = destCards.findIndex((card) => card.id === overId)
      let insertAt: number
      if (overId === overColumnId) {
        insertAt = destCards.length
      } else if (overCardIndex >= 0) {
        const isBelowOverItem =
          active.rect.current.translated &&
          active.rect.current.translated.top >
            over.rect.top + over.rect.height
        insertAt = overCardIndex + (isBelowOverItem ? 1 : 0)
      } else {
        insertAt = destCards.length
      }
      destCards.splice(Math.min(insertAt, destCards.length), 0, moved)

      return prev.map((column, index) => {
        if (index === sourceIndex) return { ...column, cards: sourceCards }
        if (index === destIndex) return { ...column, cards: destCards }
        return column
      })
    })
  }

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event
    setActiveCard(null)
    setActiveCardWidth(null)
    if (!over) return

    const activeId = String(active.id)
    const overId = String(over.id)
    if (activeId === overId) return

    setColumns((prev) => {
      const columnId = findColumnId(prev, activeId)
      const overColumnId = findColumnId(prev, overId)
      if (!columnId || !overColumnId || columnId !== overColumnId) return prev

      const columnIndex = prev.findIndex((column) => column.id === columnId)
      if (columnIndex < 0) return prev
      const cards = prev[columnIndex].cards
      const oldIndex = cards.findIndex((card) => card.id === activeId)
      const newIndex =
        overId === overColumnId
          ? cards.length - 1
          : cards.findIndex((card) => card.id === overId)
      if (oldIndex < 0 || newIndex < 0 || oldIndex === newIndex) return prev
      return prev.map((column, index) =>
        index === columnIndex
          ? { ...column, cards: arrayMove(cards, oldIndex, newIndex) }
          : column
      )
    })
  }

  const handleDragCancel = () => {
    setActiveCard(null)
    setActiveCardWidth(null)
  }

  const selectedCard = selectedId ? findCard(columns, selectedId) : undefined
  const showDetailPanel = panelOpen && selectedCard != null

  const isFeaturedDetail =
    selectedId != null &&
    selectedId === activeBoard.detailCardId &&
    activeBoard.detail != null

  const panelTitle = isFeaturedDetail
    ? activeBoard.detail!.title
    : (selectedCard?.title ?? "")
  const panelDescription = isFeaturedDetail
    ? activeBoard.detail!.description
    : (selectedCard?.description ?? "")
  const panelPriority = isFeaturedDetail
    ? activeBoard.detail!.priority
    : (selectedCard?.priority ?? "NEW")
  const detailMembers = isFeaturedDetail
    ? activeBoard.detail!.members
    : (selectedCard?.assignees.map((person) => {
        const known = WORKSPACE_MEMBERS.find(
          (member) => member.initials === person.initials
        )
        return {
          initials: person.initials,
          tone: person.tone,
          name: known?.name ?? person.initials,
        }
      }) ?? [])

  const mentionCandidates = useMemo(() => {
    const fromMembers = detailMembers.map((member) => {
      const known = WORKSPACE_MEMBERS.find(
        (item) => item.initials === member.initials
      )
      return {
        initials: member.initials,
        tone: member.tone,
        name: member.name,
        handle: known?.handle ?? member.initials.toLowerCase(),
      } satisfies MentionUser
    })
    const byInitials = new Map(fromMembers.map((user) => [user.initials, user]))
    for (const member of WORKSPACE_MEMBERS) {
      if (!byInitials.has(member.initials)) {
        byInitials.set(member.initials, member)
      }
    }
    return Array.from(byInitials.values())
  }, [detailMembers])

  const detailMessages =
    selectedId != null ? (chatByCardId[selectedId] ?? []) : []

  const mentionQuery = getMentionQuery(draftMessage)
  const filteredMentions =
    mentionQuery == null
      ? []
      : mentionCandidates.filter(
          (user) =>
            user.handle.startsWith(mentionQuery) ||
            user.name.toLowerCase().startsWith(mentionQuery) ||
            user.initials.toLowerCase().startsWith(mentionQuery)
        )

  useEffect(() => {
    setDraftMessage("")
    setMentionIndex(0)
  }, [selectedId, activeBoardId])

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [detailMessages.length, selectedId])

  useEffect(() => {
    setMentionIndex(0)
  }, [mentionQuery])

  const insertMention = (user: MentionUser) => {
    setDraftMessage((prev) =>
      prev.replace(/(?:^|\s)@([\w]*)$/, (match) => {
        const prefix = match.startsWith(" ") ? " " : ""
        return `${prefix}@${user.handle} `
      })
    )
    setMentionIndex(0)
  }

  const sendMessage = () => {
    const text = draftMessage.trim()
    if (!text || !selectedId) return

    const message: ChatMessage = {
      id: `msg-${selectedId}-${Date.now()}`,
      initials: "MS",
      tone: "amber",
      text,
      meta: `May Sh · ${formatChatTime()}`,
    }

    setChatByCardId((prev) => ({
      ...prev,
      [selectedId]: [...(prev[selectedId] ?? []), message],
    }))
    setDraftMessage("")
    setMentionIndex(0)

    setColumns((prev) =>
      prev.map((column) => ({
        ...column,
        cards: column.cards.map((card) =>
          card.id === selectedId
            ? { ...card, comments: (card.comments ?? 0) + 1 }
            : card
        ),
      }))
    )
  }

  return (
    <div className="flex h-dvh min-h-[700px] w-full overflow-hidden bg-white">
      {/* Sidebar */}
      <aside className="cw-sidebar-shadow flex w-[220px] shrink-0 flex-col overflow-hidden border-r border-cw-border bg-white">
        <div className="flex w-full flex-col overflow-y-auto">
          <div className="flex h-16 items-center gap-2.5 border-b border-cw-border px-[18px]">
            <span className="text-[28px] font-black leading-none text-[#f2a000]">
              CW
            </span>
            <div className="flex flex-col gap-px">
              <span className="text-xs text-cw-text">Creative Wizards</span>
              <span className="text-[10px] text-cw-secondary">Workspace</span>
            </div>
          </div>

          <nav className="flex flex-col gap-0.5 pt-7">
            <NavItem icon="/icons/folder.svg" label="Assets" />
            <NavItem icon="/icons/users.svg" label="Members" />
            <NavItem
              icon="/icons/settings.svg"
              label="Workspace settings"
              onClick={() => setSettingsOpen(true)}
            />
          </nav>

          <p className="pl-[18px] pt-7 text-xs font-bold text-cw-text">
            Workspace views
          </p>
          <nav className="flex flex-col pt-2">
            <NavItem icon="/icons/grid.svg" label="Table" />
            <NavItem icon="/icons/calendar.svg" label="Calendar" />
          </nav>

          <p className="pl-[18px] pt-7 text-xs font-bold text-cw-text">
            Your boards
          </p>
          <nav className="flex flex-col pt-2">
            {BOARDS.map((board) => (
              <NavItem
                key={board.id}
                icon={board.icon}
                label={board.name}
                active={board.id === activeBoardId}
                onClick={() => switchBoard(board.id)}
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
              {`Workspace  /  ${activeBoard.name}`}
            </p>
            <label className="flex w-[250px] max-w-full items-center gap-2 rounded-md bg-cw-bg px-3 py-2">
              <Icon src="/icons/search.svg" size={14} />
              <input
                className="w-full bg-transparent text-xs text-cw-text outline-none placeholder:text-cw-placeholder"
                placeholder="Search tasks"
              />
            </label>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={() => setModalOpen(true)}
              className="rounded-md bg-cw-accent px-4 py-2 text-[13px] font-bold text-white hover:bg-[#d99c1c]"
            >
              + Create
            </button>
            <UserMenu onOpenSettings={() => setSettingsOpen(true)} />
          </div>
        </header>

        <div className="flex min-h-0 flex-1">
          {/* Board — static until client mount to avoid @dnd-kit aria ID hydration mismatch */}
          {dndReady ? (
            <DndContext
              key={activeBoard.id}
              sensors={sensors}
              collisionDetection={closestCorners}
              onDragStart={handleDragStart}
              onDragOver={handleDragOver}
              onDragEnd={handleDragEnd}
              onDragCancel={handleDragCancel}
            >
              <div className="flex min-w-0 flex-1 gap-0 overflow-hidden bg-cw-bg p-[18px]">
                {boardColumns.map((column, columnIndex) => (
                  <SortableKanbanColumn
                    key={`${activeBoard.id}-${column.id}`}
                    column={column}
                    columnIndex={columnIndex}
                    columnCount={boardColumns.length}
                    onSelectCard={(id) => {
                      setSelectedId(id)
                      setPanelOpen(true)
                    }}
                    onAddCard={() => setModalOpen(true)}
                  />
                ))}
              </div>
              <DragOverlay dropAnimation={null}>
                {activeCard ? (
                  <div
                    className="w-full rotate-[2deg] cursor-grabbing"
                    style={
                      activeCardWidth != null
                        ? { width: activeCardWidth }
                        : undefined
                    }
                  >
                    <TaskCardContent
                      card={{ ...activeCard, selected: false }}
                      dragging
                    />
                  </div>
                ) : null}
              </DragOverlay>
            </DndContext>
          ) : (
            <div className="flex min-w-0 flex-1 gap-0 overflow-hidden bg-cw-bg p-[18px]">
              {boardColumns.map((column, columnIndex) => (
                <StaticKanbanColumn
                  key={`${activeBoard.id}-${column.id}`}
                  column={column}
                  columnIndex={columnIndex}
                  columnCount={boardColumns.length}
                  onSelectCard={(id) => {
                    setSelectedId(id)
                    setPanelOpen(true)
                  }}
                  onAddCard={() => setModalOpen(true)}
                />
              ))}
            </div>
          )}

          {/* Detail panel — driven by the selected card */}
          {showDetailPanel && selectedCard && (
            <aside className="cw-panel-shadow flex w-[290px] shrink-0 flex-col overflow-hidden border-l border-cw-border bg-white">
              <button
                type="button"
                onClick={() => setPanelOpen(false)}
                className="flex h-[52px] shrink-0 items-center gap-2 border-b border-cw-border px-4 text-xs text-cw-secondary hover:bg-[#faf9f7]"
              >
                <Icon src="/icons/arrow-left.svg" size={14} />
                Back
              </button>

              <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                <div className="shrink-0 border-b border-cw-border p-4">
                  <div className="mb-[9px] flex items-center justify-between gap-2">
                    <h2 className="text-lg font-bold text-cw-text">
                      {panelTitle}
                    </h2>
                    <button
                      type="button"
                      className="flex size-7 items-center justify-center rounded-md border border-[#e4e2de] hover:bg-[#faf9f7]"
                      aria-label="Edit task"
                    >
                      <Icon src="/icons/edit.svg" size={14} />
                    </button>
                  </div>
                  <p className="mb-[9px] text-xs leading-[1.4] text-cw-secondary">
                    {panelDescription}
                  </p>
                  <PriorityPill priority={panelPriority} large />
                </div>

                <div className="shrink-0 border-b border-cw-border p-4">
                  <p className="mb-2 text-[13px] font-bold text-cw-text">
                    Members
                  </p>
                  <div className="flex items-center gap-2">
                    {detailMembers.map((member) => (
                      <div
                        key={member.initials}
                        className="flex items-center gap-1.5"
                        title={member.name}
                      >
                        <Avatar
                          initials={member.initials}
                          tone={member.tone}
                          size={24}
                        />
                      </div>
                    ))}
                  </div>
                </div>

                <div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
                  <div className="flex shrink-0 items-center justify-between">
                    <p className="text-[13px] font-bold text-cw-text">
                      Task chat
                    </p>
                    <div className="flex items-center gap-1.5">
                      <Icon src="/icons/avatar.svg" size={18} />
                      <span className="text-[10px] text-cw-secondary">
                        {Math.max(detailMembers.length, 1)} participants
                      </span>
                    </div>
                  </div>

                  <div className="cw-scrollbar flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto">
                    {detailMessages.length > 0 ? (
                      detailMessages.map((message) => (
                        <div
                          key={message.id}
                          className="flex items-end gap-2"
                        >
                          <Avatar
                            initials={message.initials}
                            tone={message.tone}
                            size={24}
                          />
                          <div className="flex w-[220px] max-w-full flex-col gap-1">
                            <div className="rounded-md border border-cw-border bg-white px-2.5 py-2">
                              <p className="text-[11px] leading-[1.35] text-cw-text">
                                {renderMessageText(message.text)}
                              </p>
                            </div>
                            <p className="text-[9px] text-cw-placeholder">
                              {message.meta}
                            </p>
                          </div>
                        </div>
                      ))
                    ) : (
                      <p className="text-[11px] text-cw-placeholder">
                        No messages yet for this task.
                      </p>
                    )}
                    <div ref={chatEndRef} />
                  </div>

                  <form
                    className="relative flex shrink-0 items-center gap-2"
                    onSubmit={(event) => {
                      event.preventDefault()
                      if (filteredMentions.length > 0) {
                        insertMention(
                          filteredMentions[
                            Math.min(mentionIndex, filteredMentions.length - 1)
                          ]
                        )
                        return
                      }
                      sendMessage()
                    }}
                  >
                    {filteredMentions.length > 0 && (
                      <div className="absolute bottom-full left-0 z-20 mb-2 w-full overflow-hidden rounded-lg border border-cw-border bg-white shadow-[0_8px_24px_rgba(0,0,0,0.08)]">
                        <p className="border-b border-cw-border px-3 py-2 text-[10px] font-semibold uppercase tracking-wide text-cw-placeholder">
                          Mention someone
                        </p>
                        <ul className="max-h-40 overflow-y-auto py-1">
                          {filteredMentions.map((user, index) => (
                            <li key={user.initials}>
                              <button
                                type="button"
                                onMouseDown={(event) => {
                                  event.preventDefault()
                                  insertMention(user)
                                }}
                                className={cn(
                                  "flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-[#fff8e9]",
                                  index === mentionIndex && "bg-[#fff8e9]"
                                )}
                              >
                                <Avatar
                                  initials={user.initials}
                                  tone={user.tone}
                                  size={22}
                                />
                                <span className="min-w-0 flex-1">
                                  <span className="block truncate text-[12px] font-semibold text-cw-text">
                                    {user.name}
                                  </span>
                                  <span className="block text-[10px] text-cw-placeholder">
                                    @{user.handle}
                                  </span>
                                </span>
                              </button>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                    <input
                      value={draftMessage}
                      onChange={(event) => setDraftMessage(event.target.value)}
                      onKeyDown={(event) => {
                        if (filteredMentions.length === 0) return
                        if (event.key === "ArrowDown") {
                          event.preventDefault()
                          setMentionIndex(
                            (index) => (index + 1) % filteredMentions.length
                          )
                        } else if (event.key === "ArrowUp") {
                          event.preventDefault()
                          setMentionIndex(
                            (index) =>
                              (index - 1 + filteredMentions.length) %
                              filteredMentions.length
                          )
                        } else if (event.key === "Escape") {
                          event.preventDefault()
                          setDraftMessage((prev) =>
                            prev.replace(/(?:^|\s)@[\w]*$/, (match) =>
                              match.startsWith(" ") ? " " : ""
                            )
                          )
                        }
                      }}
                      className="min-h-[34px] min-w-0 flex-1 rounded-md border border-cw-border bg-white px-2.5 py-[9px] text-[11px] text-cw-text outline-none placeholder:text-cw-placeholder focus:border-cw-accent"
                      placeholder="Write a message… use @ to mention"
                    />
                    <button
                      type="submit"
                      disabled={!draftMessage.trim()}
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

      {modalOpen && <CreateTaskModal onClose={() => setModalOpen(false)} />}
      {settingsOpen && (
        <SettingsModal onClose={() => setSettingsOpen(false)} />
      )}
    </div>
  )
}
