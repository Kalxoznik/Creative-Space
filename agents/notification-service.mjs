import { createNotifications } from "./notify.mjs"
import { createTelegramInbox } from "./telegram.mjs"
import { telegramCredentials } from "./telegram-settings.mjs"

// Reconfigure both directions together. A changed bot starts from now, so queued notices
// for the old chat cannot be replayed into a newly connected chat. Dev still loads .env once.
export function createNotificationService({
  call, boardUrl, env = process.env,
  makeNotifications = createNotifications, makeInbox = createTelegramInbox,
}) {
  let notifications = makeNotifications({ call, boardUrl, env })
  let credentials = JSON.stringify(telegramCredentials(env))
  let inbox = makeInbox({ call, env })
  if (inbox) void inbox.start()

  const refresh = () => {
    if (env.CS_APP !== "1") return
    const current = JSON.stringify(telegramCredentials(env))
    if (current === credentials) return
    credentials = current
    inbox?.stop()
    notifications = makeNotifications({ call, boardUrl, env })
    inbox = makeInbox({ call, env })
    if (inbox) void inbox.start()
  }
  return { refresh, tick: () => notifications.tick(), stop: () => inbox?.stop() }
}
