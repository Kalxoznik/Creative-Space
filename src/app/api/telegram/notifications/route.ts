import { handle, json, readJson } from "@/server/http"
import {
  lastTelegramNotification,
  rememberTelegramNotification,
  taskByRef,
  taskOfTelegramNotification,
} from "@/server/store"

export const dynamic = "force-dynamic"

// Where a message from the Telegram bot can land (agents/telegram.mjs): the card a notification
// was about, the card the owner named by number, or the card of the last notification sent. The
// worker owns the bot and never opens the board's database itself, so it asks here. Which of the
// three applies — and how old "last" may be — is the bot's rule, not this route's.

export const GET = handle(async (request: Request) => {
  const params = new URL(request.url).searchParams
  if (params.has("last")) return json({ link: lastTelegramNotification() })
  if (params.has("ref")) return json({ link: taskByRef(params.get("ref")) })
  const messageId = Number(params.get("message"))
  return json({ link: Number.isFinite(messageId) ? taskOfTelegramNotification(messageId) : null })
})

export const POST = handle(async (request: Request) => {
  const body = await readJson(request)
  return json(
    rememberTelegramNotification({
      messageId: body.messageId,
      taskId: body.taskId,
      boardMessageId: body.boardMessageId,
    }),
    { status: 201 }
  )
})
