import { bus, type ChangeEvent, type WorkerEvent } from "@/server/events"
import { listBoardEvents } from "@/server/feed"
import { getDb } from "@/server/db"
import { json } from "@/server/http"

export const dynamic = "force-dynamic"

// Two readers of the same word, told apart by `?board=`:
//
// - `?board=<key|id>&since=<id>&limit=<n>` → the board's stored feed as JSON, oldest first.
//   For a client that is not a browser (an architect in a chat, the notifications): it asks
//   what happened since the last id it saw, whenever it likes. Read-only.
// - no query → the live SSE stream the browser subscribes to: one line per change, nothing
//   stored, and the payload only says what moved, not the data itself.
export async function GET(request: Request): Promise<Response> {
  getDb() // make sure the store is initialised before anyone subscribes
  const params = new URL(request.url).searchParams
  const board = params.get("board")
  if (board !== null) {
    const number = (name: string): number | undefined => {
      const raw = params.get(name)
      if (raw === null || raw.trim() === "") return undefined
      const value = Number(raw)
      return Number.isFinite(value) ? value : undefined
    }
    const feed = listBoardEvents(board, { since: number("since"), limit: number("limit") })
    if (!feed) return json({ error: `No board matches '${board}'` }, { status: 404 })
    return json(feed)
  }
  const encoder = new TextEncoder()

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (line: string) => {
        try {
          controller.enqueue(encoder.encode(line))
        } catch {
          // stream already closed
        }
      }
      const onChange = (event: ChangeEvent | WorkerEvent) => send(`data: ${JSON.stringify(event)}\n\n`)
      const ping = setInterval(() => send(": ping\n\n"), 15000)

      bus().on("change", onChange)
      send(`data: ${JSON.stringify({ type: "hello", at: new Date().toISOString() })}\n\n`)

      request.signal.addEventListener("abort", () => {
        clearInterval(ping)
        bus().off("change", onChange)
        try {
          controller.close()
        } catch {
          // already closed
        }
      })
    },
  })

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  })
}
