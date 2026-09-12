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
      return json({ error: message }, { status: 500 })
    }
  }
}
