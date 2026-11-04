// App credentials have exactly one source: the app's private data directory. Never fall
// back to shell variables or a checkout's .env, including when the file is broken/missing.
import fs from "node:fs"
import path from "node:path"
import { randomUUID } from "node:crypto"

function settingsPath(env) {
  const dir = env.CS_APP_DATA_DIR
  return env.CS_APP === "1" && dir && path.isAbsolute(dir)
    ? path.join(/* turbopackIgnore: true */ dir, "telegram.json")
    : null
}

function valid(token, chatId) {
  return typeof token === "string" && /^\d+:[A-Za-z0-9_-]+$/.test(token) &&
    typeof chatId === "string" && /^-?\d+$/.test(chatId)
}

export function telegramCredentials(env = process.env) {
  if (env.CS_APP !== "1") {
    return { token: (env.TELEGRAM_BOT_TOKEN ?? "").trim(), chatId: (env.TELEGRAM_CHAT_ID ?? "").trim() }
  }
  const file = settingsPath(env)
  try {
    const saved = file && JSON.parse(fs.readFileSync(file, "utf8"))
    if (saved?.enabled === true && valid(saved.token, saved.chatId)) {
      return { token: saved.token, chatId: saved.chatId }
    }
  } catch {
    // Fail closed, without printing a parse error that could contain the secret.
  }
  return { token: "", chatId: "" }
}

export function telegramSettings(env = process.env) {
  const { token, chatId } = telegramCredentials(env)
  return { app: env.CS_APP === "1", enabled: Boolean(token && chatId), chatId }
}

export class TelegramSettingsError extends Error {}

export function saveTelegramSettings(input, env = process.env) {
  const file = settingsPath(env)
  if (!file) throw new TelegramSettingsError("Telegram settings are available in the Mac app only.")
  if (typeof input.enabled !== "boolean") throw new TelegramSettingsError("Choose whether Telegram is enabled.")
  if (!input.enabled) {
    fs.rmSync(file, { force: true })
    return telegramSettings(env)
  }
  const previous = telegramCredentials(env)
  const token = typeof input.token === "string" ? input.token.trim() || previous.token : previous.token
  const chatId = typeof input.chatId === "string" ? input.chatId.trim() : ""
  if (!valid(token, chatId)) throw new TelegramSettingsError("Enter a valid bot token and numeric chat ID.")
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  // Atomic replacement: the worker never sees half a token; every replacement stays private.
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    fs.writeFileSync(temporary, JSON.stringify({ enabled: true, token, chatId }), { mode: 0o600, flag: "wx" })
    fs.renameSync(temporary, file)
  } finally {
    fs.rmSync(temporary, { force: true })
  }
  return telegramSettings(env)
}
