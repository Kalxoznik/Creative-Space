import { handle, json } from "@/server/http"
import { getState } from "@/server/store"

export const dynamic = "force-dynamic"

export const GET = handle(() => json(getState()))
