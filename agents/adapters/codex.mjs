// Codex CLI adapter — non-interactive `codex exec`. Used for the Coder: it may
// edit files and commit inside the repository (workspace-write sandbox).
// The agent's configuration sets the model (`-m`) and the effort level, passed as
// `-c model_reasoning_effort=…` (Creative Space "max" = Codex "xhigh").
//
// Requires Codex CLI installed and logged in on this machine:
//   npm i -g @openai/codex   →   codex login
// Override the binary with CS_CODEX_BIN.
//
// `--json` streams the run as events, which the worker watches for loops (`agents/loops.mjs`);
// the final answer still comes from `-o`, and codex's own errors from the `error` events.

import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { runCommand } from "./process.mjs"
import { projectDir } from "../project-dir.mjs"
import { buildPrompt, modelRejection, parseReply, PROJECT_ROOT } from "../lib.mjs"
import { codexSteps, loopError, loopWatch } from "../loops.mjs"

/**
 * What a `--json` stream said in words: its errors as the `ERROR: …` lines codex prints without
 * `--json` (what `codexFailure` reads), and its last message — the answer when `-o` wrote none.
 */
export function codexStreamText(events) {
  const errors = []
  let lastMessage = ""
  for (const event of events) {
    const message =
      event?.type === "error" ? event.message : event?.type === "turn.failed" ? event.error?.message : null
    if (typeof message === "string" && message.trim()) errors.push(`ERROR: ${message.trim()}`)
    if (event?.type === "item.completed" && event.item?.type === "agent_message" && typeof event.item.text === "string") {
      lastMessage = event.item.text
    }
  }
  return { errors: errors.join("\n"), lastMessage: lastMessage.trim() }
}

const CODEX_EFFORT = { low: "low", medium: "medium", high: "high", max: "xhigh" }

/**
 * The error for a `codex exec` that exited non-zero. No JSON envelope here and no turn limit
 * of ours to hit: codex writes its own reason to stderr, so there is little to translate the
 * way claude.mjs has to — except a model it turned down, which is named with the model and
 * carries the owner's line. That is read off codex's own last `ERROR: …` line only: the rest
 * of the output is the agent's activity, and an agent that read a test quoting a rejected
 * model would otherwise turn a usage limit into "rejected model". The one case with nothing
 * to quote is a CLI that died saying nothing — don't report a bare colon.
 */
export function codexFailure(code, stderr, stdout, model = null) {
  const said = ((stderr ?? "").slice(-800) || (stdout ?? "").slice(-800)).trim()
  const lastError = (text) => (text ?? "").match(/^ERROR:.*$/gm)?.at(-1)
  const rejected = modelRejection("Codex", model, lastError(stderr) ?? lastError(stdout) ?? "")
  if (rejected) {
    const error = new Error(rejected)
    error.plain = rejected
    return error
  }
  return new Error(`codex exited with ${code}${said ? `: ${said}` : " without saying why"}`)
}

export async function runCodex(role, context, { log, timeoutMs, signal }) {
  const prompt = await buildPrompt(role, context)
  const cwd = projectDir(context.board.repoPath, PROJECT_ROOT)
  const bin = process.env.CS_CODEX_BIN ?? "codex"
  const config = context.agent?.agent ?? {}
  const model = config.model || process.env.CS_CODEX_MODEL
  const effort = config.effort ? CODEX_EFFORT[config.effort] : null
  const lastMessageFile = path.join(os.tmpdir(), `cs-codex-${context.run.id}.txt`)
  // Coder: workspace-write sandbox. Architect: read-only sandbox.
  const sandbox = role === "coder" ? "workspace-write" : "read-only"
  const args = ["exec", "--json", "-s", sandbox, "--skip-git-repo-check", "-C", cwd, "-o", lastMessageFile]
  if (model) args.push("-m", model)
  if (effort) args.push("-c", `model_reasoning_effort="${effort}"`)
  args.push("-") // read the prompt from stdin

  await log(`$ ${bin} ${args.join(" ")}\n`)
  const watch = loopWatch({ parse: codexSteps, log, signal })
  const { stderr, code } = await runCommand(bin, args, {
    cwd,
    stdin: prompt,
    log,
    timeoutMs,
    signal: watch.signal,
    onLine: watch.onLine,
  })
  if (signal?.aborted) throw new Error("stopped")
  if (watch.hit) {
    await fs.unlink(lastMessageFile).catch(() => {})
    throw loopError(watch.hit)
  }
  const said = codexStreamText(watch.events)
  if (code !== 0) throw codexFailure(code, stderr, said.errors, model)

  let text = ""
  try {
    text = (await fs.readFile(lastMessageFile, "utf8")).trim()
    await fs.unlink(lastMessageFile).catch(() => {})
  } catch {
    // -o wrote nothing: the last message of the stream is the same answer
    text = said.lastMessage
  }
  const { reply, actions, decision, problem, plain } = parseReply(text, { trigger: context.run?.trigger, role })
  return { reply, actions, decision, problem, plain, raw: text, summary: reply.slice(0, 300) }
}
