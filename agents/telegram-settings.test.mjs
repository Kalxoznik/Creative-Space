import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { telegramCredentials, telegramSettings, saveTelegramSettings } from "./telegram-settings.mjs"
import { createNotifications, loadDotEnv, openChannels } from "./notify.mjs"
import { createTelegramInbox } from "./telegram.mjs"
import { createNotificationService } from "./notification-service.mjs"

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cs-telegram-settings-"))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.writeFileSync(path.join(root, ".env"), "TELEGRAM_BOT_TOKEN=111:owner_file\nTELEGRAM_CHAT_ID=111\nSHOULD_NOT_LOAD=yes\n")
  const env = {
    CS_APP: "1", CS_APP_DATA_DIR: path.join(root, "app-data"),
    TELEGRAM_BOT_TOKEN: "222:owner_shell", TELEGRAM_CHAT_ID: "222",
  }
  return { root, env, file: path.join(env.CS_APP_DATA_DIR, "telegram.json") }
}

test("fresh app ignores repository .env and inherited credentials in both Telegram directions", async (t) => {
  const { root, env } = fixture(t)
  const network = []
  const fetchImpl = async (...args) => { network.push(args); throw new Error("Unexpected request") }
  assert.deepEqual(loadDotEnv(root, env), [])
  assert.equal(env.SHOULD_NOT_LOAD, undefined)
  assert.deepEqual(telegramSettings(env), { app: true, enabled: false, chatId: "" })
  const notifications = createNotifications({
    call: async () => { throw new Error("No feed expected without channels") },
    root, env, platform: "linux", log: () => {}, fetchImpl,
  })
  await notifications.tick()
  assert.equal(createTelegramInbox({ call: async () => {}, env, fetchImpl }), null)
  assert.deepEqual(network, [])
  assert.deepEqual(openChannels({ env, platform: "darwin", log: () => {} }).map((c) => c.name), ["macOS"])
})

test("app settings persist privately, redact the token, preserve it on edit, and remove it on disconnect", (t) => {
  const { env, file } = fixture(t)
  const saved = saveTelegramSettings({ enabled: true, token: " 333:user_bot ", chatId: " -333 " }, env)
  assert.deepEqual(saved, { app: true, enabled: true, chatId: "-333" })
  assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  assert.deepEqual(telegramCredentials({ ...env }), { token: "333:user_bot", chatId: "-333" })
  saveTelegramSettings({ enabled: true, token: "", chatId: "444" }, env)
  assert.equal(telegramCredentials(env).token, "333:user_bot")
  assert.equal(telegramCredentials(env).chatId, "444")
  assert.throws(() => saveTelegramSettings({ enabled: true, token: "secret-invalid", chatId: "444" }, env),
    (error) => !error.message.includes("secret-invalid"))
  assert.equal(telegramCredentials(env).token, "333:user_bot", "invalid edits keep the saved connection")
  assert.deepEqual(saveTelegramSettings({ enabled: false }, env), { app: true, enabled: false, chatId: "" })
  assert.equal(fs.existsSync(file), false)
  assert.deepEqual(telegramCredentials(env), { token: "", chatId: "" })
  assert.throws(() => saveTelegramSettings({ enabled: true, chatId: "444" }, env))
})

test("broken, partial, disabled or missing app settings fail closed, even with shell secrets", (t) => {
  const { env, file } = fixture(t)
  fs.mkdirSync(env.CS_APP_DATA_DIR)
  for (const value of ["{broken-secret", "null", "{}",
    JSON.stringify({ enabled: true, token: "333:user_bot" }),
    JSON.stringify({ enabled: false, token: "333:user_bot", chatId: "333" })]) {
    fs.writeFileSync(file, value)
    assert.deepEqual(telegramCredentials(env), { token: "", chatId: "" })
  }
  assert.deepEqual(telegramCredentials({ ...env, CS_APP_DATA_DIR: undefined }), { token: "", chatId: "" })
  assert.deepEqual(telegramCredentials({ ...env, CS_APP_DATA_DIR: "relative" }), { token: "", chatId: "" })
})

test("outbound and inbound use only the saved bot, and old senders stop after disconnect", async (t) => {
  const { env } = fixture(t)
  saveTelegramSettings({ enabled: true, token: "333:user_bot", chatId: "333" }, env)
  const requests = []
  const fetchImpl = async (url, init) => {
    requests.push({ url, body: JSON.parse(init.body) })
    return { ok: true, json: async () => ({ ok: true, result: [] }) }
  }
  const [channel] = openChannels({ env, platform: "linux", log: () => {}, fetchImpl })
  await channel.send({ label: "Review", ref: "BI-1", title: "Test" })
  const inbox = createTelegramInbox({ call: async () => {}, env, fetchImpl })
  await inbox.poll()
  assert.equal(requests.length, 2)
  assert.equal(requests[0].url, "https://api.telegram.org/bot333:user_bot/sendMessage")
  assert.equal(requests[0].body.chat_id, "333")
  assert.equal(requests[1].url, "https://api.telegram.org/bot333:user_bot/getUpdates")
  saveTelegramSettings({ enabled: false }, env)
  await channel.send({ label: "Review", ref: "BI-2", title: "Do not send" })
  await assert.rejects(inbox.poll(), /settings changed/)
  assert.equal(requests.length, 2)
  inbox.stop()
})

test("worker switches both directions live and does not restart them on unchanged settings", async (t) => {
  const { env } = fixture(t)
  const log = []
  const service = createNotificationService({
    call: async () => {}, env,
    makeNotifications: ({ env }) => {
      const { chatId } = telegramCredentials(env)
      log.push(`notifier:${chatId}`)
      return { tick: async () => log.push(`tick:${chatId}`) }
    },
    makeInbox: ({ env }) => {
      const { chatId } = telegramCredentials(env)
      return chatId ? { start: async () => log.push(`start:${chatId}`), stop: () => log.push(`stop:${chatId}`) } : null
    },
  })
  saveTelegramSettings({ enabled: true, token: "333:user_bot", chatId: "333" }, env)
  service.refresh()
  await service.tick()
  service.refresh()
  saveTelegramSettings({ enabled: true, token: "444:replacement", chatId: "444" }, env)
  service.refresh()
  saveTelegramSettings({ enabled: false }, env)
  service.refresh()
  await service.tick()
  service.stop()
  assert.deepEqual(log, ["notifier:", "notifier:333", "start:333", "tick:333", "stop:333",
    "notifier:444", "start:444", "stop:444", "notifier:", "tick:"])
})

test("a long poll already in flight cannot file a message after disconnect", async (t) => {
  const { env } = fixture(t)
  saveTelegramSettings({ enabled: true, token: "333:user_bot", chatId: "333" }, env)
  const calls = []
  const inbox = createTelegramInbox({
    call: async (...args) => { calls.push(args) }, env,
    fetchImpl: async () => {
      saveTelegramSettings({ enabled: false }, env)
      return { ok: true, json: async () => ({ ok: true, result: [{
        update_id: 1, message: { message_id: 1, chat: { id: 333 }, text: "BI-1 please change this" },
      }] }) }
    },
  })
  await inbox.poll()
  assert.deepEqual(calls, [])
  inbox.stop()
})

test("dev still loads .env with shell precedence, and cannot write app settings", (t) => {
  const { root, env: appEnv } = fixture(t)
  const env = { TELEGRAM_CHAT_ID: "999", CS_APP_DATA_DIR: appEnv.CS_APP_DATA_DIR }
  createNotifications({ call: async () => ({}), root, env, platform: "linux", log: () => {} })
  assert.deepEqual(telegramCredentials(env), { token: "111:owner_file", chatId: "999" })
  assert.ok(createTelegramInbox({ call: async () => {}, env }))
  assert.throws(() => saveTelegramSettings({ enabled: false }, env), /Mac app only/)
})
