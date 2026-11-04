import { json, readJson } from "@/server/http"
import { saveTelegramSettings, telegramSettings, TelegramSettingsError } from "../../../../../agents/telegram-settings.mjs"

export const dynamic = "force-dynamic"

export function GET() {
  return json(telegramSettings())
}

export async function PUT(request: Request) {
  // This local setting accepts credentials only from our own UI, not a cross-site form.
  const origin = request.headers.get("origin")
  if ((origin && origin !== new URL(request.url).origin) || !request.headers.get("content-type")?.startsWith("application/json")) {
    return json({ error: "Use Workspace settings to connect Telegram." }, { status: 403 })
  }
  try {
    return json(saveTelegramSettings(await readJson(request)))
  } catch (error) {
    return json({ error: error instanceof TelegramSettingsError ? error.message : "Could not save Telegram settings." }, {
      status: error instanceof TelegramSettingsError ? 400 : 500,
    })
  }
}
