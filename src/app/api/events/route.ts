import { bus, type ChangeEvent } from "@/server/events"
import { getDb } from "@/server/db"

export const dynamic = "force-dynamic"

// Server-sent events: one line per change. Clients refetch what they show;
// the payload only says what moved, not the data itself.
export async function GET(request: Request): Promise<Response> {
  getDb() // make sure the store is initialised before anyone subscribes
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
      const onChange = (event: ChangeEvent) => send(`data: ${JSON.stringify(event)}\n\n`)
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
