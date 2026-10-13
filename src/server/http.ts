import { NextResponse } from "next/server"
import { NotFoundError, ValidationError } from "./store"

export function json(data: unknown, init?: { status?: number }): NextResponse {
  return NextResponse.json(data, {
    status: init?.status ?? 200,
    headers: { "Cache-Control": "no-store" },
  })
}

export async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = await request.json()
    return body && typeof body === "object" ? (body as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/**
 * SQLite saying "no such column" means the code and the database file disagree about the
 * schema — the board was reloaded but its database was not migrated with it. The worker used
 * to see this as a bare 500 and could not tell it from a bug; now it reads as what it is.
 */
const SCHEMA_MISMATCH = /no such (?:column|table)\b/i

/** Wrap a handler so store errors map to proper HTTP statuses. */
export function handle<T extends unknown[]>(
  fn: (...args: T) => Promise<Response> | Response
): (...args: T) => Promise<Response> {
  return async (...args: T) => {
    try {
      return await fn(...args)
    } catch (error) {
      if (error instanceof ValidationError) {
        return json({ error: error.message }, { status: 400 })
      }
      if (error instanceof NotFoundError) {
        return json({ error: error.message }, { status: 404 })
      }
      console.error(error)
      const message = error instanceof Error ? error.message : "Internal error"
      if (SCHEMA_MISMATCH.test(message)) {
        return json(
          { error: `The board's database is behind the code (${message}) — restart the board (npm run up).` },
          { status: 503 }
        )
      }
      return json({ error: message }, { status: 500 })
    }
  }
}
