import { emitWorker } from "./events"
import type { WorkerStatus } from "@/lib/types"

// The agent worker is a separate process; the board only knows it through heartbeats.
// Kept in memory (per server process): a restarted server learns it again on the next beat.

/** No heartbeat for this long = offline (the worker beats every ~5s). */
const STALE_MS = 15_000

type Stored = { mode: "stub" | "live"; seenAt: number; engines: Record<string, string | null> }
type GlobalWithWorker = typeof globalThis & { __creativeSpaceWorker?: Stored | null }

function stored(): Stored | null {
  return (globalThis as GlobalWithWorker).__creativeSpaceWorker ?? null
}

export function getWorkerStatus(): WorkerStatus {
  const s = stored()
  if (!s) return { online: false, mode: null, seenAt: null, engines: {} }
  return {
    online: Date.now() - s.seenAt < STALE_MS,
    mode: s.mode,
    seenAt: new Date(s.seenAt).toISOString(),
    engines: s.engines,
  }
}

/** Called by POST /api/agents/heartbeat. Every beat is forwarded to browsers over SSE. */
export function reportHeartbeat(input: { mode: unknown; engines: unknown }): WorkerStatus {
  const mode = input.mode === "live" ? "live" : "stub"
  const engines: Record<string, string | null> = {}
  if (input.engines && typeof input.engines === "object") {
    for (const [name, version] of Object.entries(input.engines as Record<string, unknown>)) {
      if (/^[a-z]+$/.test(name)) engines[name] = typeof version === "string" && version ? version.slice(0, 80) : null
    }
  }
  ;(globalThis as GlobalWithWorker).__creativeSpaceWorker = { mode, seenAt: Date.now(), engines }
  const status = getWorkerStatus()
  emitWorker(status)
  return status
}
