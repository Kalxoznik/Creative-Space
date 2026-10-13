// Turning CLI output into text a person can read. Used by the card digest and by the event
// feed — both quote things a CLI wrote, and neither may pass escape sequences on to a client.
//
// A CLI writes colour, cursor moves and window titles into its output whenever it thinks it has
// a terminal, and the run log keeps all of it verbatim. Two shapes cover what they emit:

/** An operating-system command — `ESC ] 0 ; <title> BEL`: free text up to its terminator. */
const OSC_RE = /\][^]*(?:|\\|)?/g
/** A control sequence — `ESC [ <params> <letter>`: colour, erase, cursor (the `ansi-regex` branch). */
const CSI_RE = /[][[()#;?]*(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]/g

/**
 * Plain text: no escape sequences, and no carriage-return overwriting. A spinner redraws its
 * line with `\r` on every frame, so only what is after the last `\r` was ever on screen.
 */
export function stripAnsi(text: string): string {
  return text
    .replace(OSC_RE, "")
    .replace(CSI_RE, "")
    .split("\n")
    .map((line) => {
      const frames = line.split("\r")
      return frames[frames.length - 1]
    })
    .join("\n")
}

/**
 * The marker of the line an agent writes for the owner — `In short: …`. `Briefly:` and its
 * Russian twin (spelled as escapes, so the source stays Latin) are accepted too: agents write in
 * the owner's language and translate the marker along with it. The same expression lives in
 * `agents/lib.mjs`: the worker runs plain `.mjs` and cannot import the TypeScript, the way
 * `taskRef` is kept in two places.
 */
const PLAIN_MARKER =
  /^\s*(?:[-*>]\s*)?(?:\*\*|__)?\s*(?:In short|Briefly|\u{41A}\u{43E}\u{440}\u{43E}\u{442}\u{43A}\u{43E})(?:\*\*|__)?\s*[:：]\s*(.+)$/iu
/** How much of a message is quoted when it has no line of its own — a glance, not the message. */
const ASKED_MAX = 200

/**
 * The `In short: …` line of a message, without the marker and without markdown decoration — or
 * null when there is none. The last such line wins: an agent that quotes the rule before
 * following it ends with the real one.
 */
export function shortLine(text: string): string | null {
  let found: string | null = null
  for (const line of stripAnsi(String(text ?? "")).split("\n")) {
    const match = line.match(PLAIN_MARKER)
    if (match) found = match[1]
  }
  const plain = (found ?? "")
    .replace(/[`*_]/g, "")
    .replace(/\s+/g, " ")
    .trim()
  return plain || null
}

/**
 * What a notification is allowed to quote of a message addressed to the owner: the agent's own
 * `In short:` line, and failing that the first `max` characters of its prose. Code is taken out —
 * a ``` block and a backtick span are the parts of a reply that hold paths and diffs, and a
 * notification is a sentence the owner reads on a phone, not a report.
 */
export function askedLine(text: string, max = ASKED_MAX): string | null {
  const short = shortLine(text)
  if (short) return short
  const lines: string[] = []
  let inFence = false
  for (const line of stripAnsi(String(text ?? "")).split("\n")) {
    if (/^\s*(?:```|~~~)/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    lines.push(line.replace(/`[^`]*`/g, " "))
  }
  const plain = lines.join(" ").replace(/\s+/g, " ").trim()
  if (!plain) return null
  return plain.length > max ? `${plain.slice(0, max - 1)}…` : plain
}

/** The last `count` lines, with the blank ones at either end dropped. */
export function tailLines(text: string, count: number): string {
  const lines = text.split("\n")
  while (lines.length && !lines[0].trim()) lines.shift()
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop()
  return lines.slice(Math.max(0, lines.length - count)).join("\n")
}
