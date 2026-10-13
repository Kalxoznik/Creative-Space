import { EventEmitter } from "node:events"

// One in-process bus. Every mutation in store.ts emits a "change"; the SSE
// route forwards it to browsers and the worker. Cached on globalThis so the
// dev server's hot reloads keep a single emitter.

export type ChangeEvent = {
  type: "change"
  scope: "board" | "thread" | "runs"
  boardId?: string
  taskId?: string
  at: string
}

/** A worker heartbeat, forwarded to browsers as-is (no refetch needed). */
export type WorkerEvent = {
  type: "worker"
  at: string
  status: import("@/lib/types").WorkerStatus
}

type GlobalWithBus = typeof globalThis & { __creativeSpaceBus?: EventEmitter }

export function bus(): EventEmitter {
  const g = globalThis as GlobalWithBus
  if (!g.__creativeSpaceBus) {
    const emitter = new EventEmitter()
    emitter.setMaxListeners(100)
    g.__creativeSpaceBus = emitter
  }
  return g.__creativeSpaceBus
}

export function emitChange(event: Omit<ChangeEvent, "type" | "at">): void {
  const payload: ChangeEvent = { type: "change", at: new Date().toISOString(), ...event }
  bus().emit("change", payload)
}

export function emitWorker(status: WorkerEvent["status"]): void {
  const payload: WorkerEvent = { type: "worker", at: new Date().toISOString(), status }
  bus().emit("change", payload)
}
