// Loop detection for a live run (BI-120).
//
// A turn limit cannot tell a stuck run from a long honest one: the Architect hit 20 turns just
// reading code for a dispatch, while a coder that runs the same failing test over and over burns
// all 80 of its own before anything stops it. So the turn limit is only a high safety net now
// (200, `agents/adapters/claude.mjs`), and the worker watches what a run actually does while the
// CLI streams it — `claude --output-format stream-json`, `codex exec --json` — and stops it when
// it goes round in circles:
//   - the same tool call with the same arguments `repeats` times in a row;
//   - the same call failing with the same error `failures` times, whatever ran in between;
//   - `idleSteps` calls in a row that only repeat calls made earlier, with no file changed.
// The last rule is "no new tool kind" read as "no new call": a dispatch reads forty different
// files with the same two tools, and that is progress, not a loop. Cycling over calls already
// made is not.
//
// Both CLIs' events are turned into the same two steps first (`claudeSteps`, `codexSteps`):
// `{ type: "call", id, tool, input, label, edits }` and `{ type: "result", id, ok, error }`.

import { createHash } from "node:crypto"

export const LOOP_LIMITS = { repeats: 3, failures: 3, idleSteps: 25 }

/** Tools whose successful call changes a file — the progress a coder's run is made of. */
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit", "file_change"])

/** The same object with its keys sorted, so `{a, b}` and `{b, a}` are the same call. */
function stable(value) {
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stable(value[key])])
    )
  }
  return value
}

const clip = (text, max) => {
  const one = String(text ?? "").replace(/\s+/g, " ").trim()
  return one.length > max ? `${one.slice(0, max - 1)}…` : one
}

/** What a call is called in the chat: the command, the file or the pattern — not its JSON. */
export function callLabel(tool, input) {
  const args = input && typeof input === "object" ? input : {}
  const said = args.command ?? args.file_path ?? args.notebook_path ?? args.pattern ?? args.path ?? args.query ?? args.url
  const what = typeof said === "string" ? said : Object.keys(args).length > 0 ? JSON.stringify(args) : ""
  return clip(what ? `${tool} ${what}` : tool, 200)
}

/**
 * The same error twice is the same whole output with only its timings out: a failing test prints
 * its own duration, and 812ms against 790ms is not a different failure. Everything else counts —
 * "# fail 3" after "# fail 5", or "got 4" after "got 5", is a run making progress, and killing it
 * costs more than missing a loop the other rules, the turn limit and the timeout still catch.
 */
function errorKey(error) {
  const text = String(error ?? "")
    .replace(/\x1b\[[0-9;]*m/g, "")
    .replace(/(duration_ms["']?\s*[:=]?\s*)\d+(\.\d+)?/gi, "$1<time>")
    .replace(/\b\d+(\.\d+)?(\s?(ms|sec|seconds?|min)|s)\b/gi, "<time>")
    .replace(/\s+/g, " ")
    .trim()
  return createHash("sha1").update(text).digest("hex")
}

/**
 * Claude Code cuts a long Bash output (`BASH_MAX_OUTPUT_LENGTH`) and marks the cut. What is left
 * may be only the start, while `node --test` prints its failures and counts at the end — so two
 * different failures can come back as the same text. Such an error is not evidence of a loop.
 */
const TRUNCATED = /\[\d+ lines? truncated\]/i

/** The first meaningful line of an error, for the chat — "Exit code 1" alone says nothing. */
function errorLine(error) {
  const lines = String(error ?? "")
    .replace(/\x1b\[[0-9;]*m/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !/^exit code \d+$/i.test(line))
  return clip(lines.find((line) => /error|fail|not ok|cannot|denied|refused/i.test(line)) ?? lines[0] ?? "", 200)
}

/**
 * Feed it steps in the order the CLI made them; `step()` returns the hit the first time a rule
 * fires, `null` until then (and the same hit after it, so a caller can ask twice).
 */
export function createLoopDetector(limits = LOOP_LIMITS) {
  const calls = new Map() // id → { key, label, edits }
  const seen = new Set()
  const failures = new Map() // call key + error → count
  let lastKey = null
  let streak = 0
  let idle = 0
  let hit = null

  const call = (step) => {
    const key = `${step.tool}\n${JSON.stringify(stable(step.input ?? {}))}`
    const label = step.label ?? callLabel(step.tool, step.input)
    const edits = step.edits ?? EDIT_TOOLS.has(step.tool)
    if (step.id != null) calls.set(step.id, { key, label, edits })
    streak = key === lastKey ? streak + 1 : 1
    lastKey = key
    if (seen.has(key)) idle += 1
    else idle = 0
    seen.add(key)
    if (streak >= limits.repeats) {
      return { kind: "repeat", count: streak, label }
    }
    if (idle >= limits.idleSteps) {
      return { kind: "idle", count: idle, label }
    }
    return null
  }

  const result = (step) => {
    const made = calls.get(step.id)
    if (!made) return null
    if (step.ok) {
      if (made.edits) idle = 0
      return null
    }
    if (TRUNCATED.test(String(step.error ?? ""))) return null
    const key = `${made.key}\n${errorKey(step.error)}`
    const count = (failures.get(key) ?? 0) + 1
    failures.set(key, count)
    if (count >= limits.failures) {
      return { kind: "failing", count, label: made.label, error: errorLine(step.error) }
    }
    return null
  }

  return {
    step(step) {
      if (hit) return hit
      hit = step.type === "call" ? call(step) : step.type === "result" ? result(step) : null
      return hit
    },
    get hit() {
      return hit
    },
  }
}

/** The chat's line for a hit: what repeated, the last call, and that the board stopped it. */
export function loopNote(hit) {
  const last = `\`${hit.label}\``
  const what =
    hit.kind === "repeat"
      ? `The same call ran ${hit.count} times in a row: ${last}.`
      : hit.kind === "failing"
        ? `The same command failed ${hit.count} times with the same error: ${last}${hit.error ? ` — ${hit.error}` : ""}.`
        : `${hit.count} calls in a row only repeated earlier ones, and no file changed. Last: ${last}.`
  return `${what} Stopped as a loop.`
}

/**
 * The error an adapter throws for a run it stopped as a loop: `loop` is the hit the worker
 * reports (`reportLoop`), `plain` the owner's line for a run that never wrote its own. Neither
 * mentions the working tree: an Architect's run never writes to it, and only the worker knows
 * whose run this was (`reportLoop` adds it for a coder).
 */
export function loopError(hit) {
  const error = new Error(loopNote(hit))
  error.loop = hit
  error.plain = "Stopped the run: it kept repeating itself."
  return error
}

/**
 * The plumbing both adapters share: the line handler for `runCommand`, and the signal that also
 * fires when the run is stopped as a loop (its reason is what the kill line in the log says).
 */
export function loopWatch({ parse, log, signal }) {
  const stop = new AbortController()
  const watch = watchStream({
    parse,
    log,
    onHit: (hit) => stop.abort(`stopped as a loop (${hit.kind}: ${hit.label})`),
  })
  return {
    onLine: watch.onLine,
    events: watch.events,
    signal: signal ? AbortSignal.any([signal, stop.signal]) : stop.signal,
    /** The hit that stopped the run, or null when it ended on its own. */
    get hit() {
      return stop.signal.aborted ? watch.detector.hit : null
    },
  }
}

/** A tool result's text: claude sends a string or a list of `{ type: "text", text }`. */
function resultText(content) {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === "string" ? part : typeof part?.text === "string" ? part.text : ""))
      .join("\n")
  }
  return ""
}

/**
 * The steps in one `claude -p --output-format stream-json` event. Tool calls ride on `assistant`
 * messages, their results on the `user` message after them. A subagent's own events
 * (`parent_tool_use_id`) are its business — the calls of the run itself are what loop.
 */
export function claudeSteps(event) {
  if (!event || event.parent_tool_use_id) return []
  const content = Array.isArray(event.message?.content) ? event.message.content : []
  if (event.type === "assistant") {
    return content
      .filter((block) => block?.type === "tool_use")
      .map((block) => ({ type: "call", id: block.id, tool: block.name, input: block.input ?? {} }))
  }
  if (event.type === "user") {
    return content
      .filter((block) => block?.type === "tool_result")
      .map((block) => ({
        type: "result",
        id: block.tool_use_id,
        ok: block.is_error !== true,
        error: block.is_error === true ? resultText(block.content) : "",
      }))
  }
  return []
}

/** `bash -lc 'npm test'` → `npm test`: codex wraps every command in a shell. */
function unwrapShell(command) {
  const text = Array.isArray(command) ? command.join(" ") : String(command ?? "")
  const wrapped = text.match(/^(?:\/\S*\/)?(?:ba|z)?sh\s+-l?c\s+(['"])([\s\S]*)\1$/)
  return wrapped ? wrapped[2] : text
}

/**
 * The steps in one `codex exec --json` event. A command is judged when it completes — that is
 * when its exit code is known — so its call and its result come out together.
 */
export function codexSteps(event) {
  if (event?.type !== "item.completed" || !event.item) return []
  const item = event.item
  const id = item.id ?? null
  const failed = item.status === "failed"
  if (item.type === "command_execution") {
    const command = unwrapShell(item.command)
    const ok = !failed && (item.exit_code == null || item.exit_code === 0)
    return [
      { type: "call", id, tool: "shell", input: { command }, label: clip(command, 200) },
      { type: "result", id, ok, error: ok ? "" : item.aggregated_output ?? "" },
    ]
  }
  if (item.type === "file_change") {
    const changes = Array.isArray(item.changes) ? item.changes : []
    const label = clip(`edit ${changes.map((c) => c?.path).filter(Boolean).join(", ")}`, 200)
    return [
      { type: "call", id, tool: "file_change", input: { changes }, label, edits: true },
      { type: "result", id, ok: !failed, error: failed ? "the change was not applied" : "" },
    ]
  }
  if (item.type === "mcp_tool_call") {
    const tool = `mcp ${item.server ?? ""}.${item.tool ?? ""}`
    return [
      { type: "call", id, tool, input: item.arguments ?? {} },
      { type: "result", id, ok: !failed, error: failed ? item.error?.message ?? "failed" : "" },
    ]
  }
  if (item.type === "web_search") {
    return [{ type: "call", id, tool: "web_search", input: { query: item.query ?? "" } }]
  }
  return []
}

/**
 * Watch a CLI's stdout line by line: every JSON event goes through `parse` into the detector,
 * the steps go into the run log as one short line each, and `onHit` fires once when a rule does.
 * Returns the line handler and the events seen, for the adapter to read the final answer from.
 */
export function watchStream({ parse, onHit, log, limits = LOOP_LIMITS }) {
  const detector = createLoopDetector(limits)
  const events = []
  const onLine = (line) => {
    const text = line.trim()
    if (!text) return
    let event
    try {
      event = JSON.parse(text)
    } catch {
      void log?.(`${text}\n`)
      return
    }
    events.push(event)
    for (const step of parse(event)) {
      if (step.type === "call") void log?.(`→ ${step.label ?? callLabel(step.tool, step.input)}\n`)
      if (step.type === "result" && !step.ok) void log?.(`  ✗ ${errorLine(step.error) || "failed"}\n`)
      const before = detector.hit
      const hit = detector.step(step)
      if (hit && !before) onHit(hit)
    }
  }
  return { onLine, events, detector }
}
