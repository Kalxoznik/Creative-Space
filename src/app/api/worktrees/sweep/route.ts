import { handle, json } from "@/server/http"
import { sweepWorktrees } from "@/server/store"

export const dynamic = "force-dynamic"

/** Worker start-up: remove the card worktrees and `cs/*` branches no card needs any more. */
export const POST = handle(async () => json(sweepWorktrees()))
