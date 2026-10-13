// Codex CLI adapter — non-interactive `codex exec`. Used for the Coder: it may
// edit files and commit inside the repository (workspace-write sandbox).
// The agent's configuration sets the model (`-m`) and the effort level, passed as
// `-c model_reasoning_effort=…` (Creative Space "max" = Codex "xhigh").
//
// Requires Codex CLI installed and logged in on this machine:
//   npm i -g @openai/codex   →   codex login
// Override the binary with CS_CODEX_BIN.

import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { runCommand } from "./process.mjs"
import { buildPrompt, parseReply, PROJECT_ROOT } from "../lib.mjs"

const CODEX_EFFORT = { low: "low", medium: "medium", high: "high", max: "xhigh" }

export async function runCodex(role, context, { log, timeoutMs, signal }) {
  const prompt = await buildPrompt(role, context)
  const cwd = context.board.repoPath ?? PROJECT_ROOT
  const bin = process.env.CS_CODEX_BIN ?? "codex"
  const config = context.agent?.agent ?? {}
  const model = config.model || process.env.CS_CODEX_MODEL
  const effort = config.effort ? CODEX_EFFORT[config.effort] : null
  const lastMessageFile = path.join(os.tmpdir(), `cs-codex-${context.run.id}.txt`)
  // Coder: workspace-write sandbox. Architect: read-only sandbox.
  const sandbox = role === "coder" ? "workspace-write" : "read-only"
  const args = ["exec", "-s", sandbox, "--skip-git-repo-check", "-C", cwd, "-o", lastMessageFile]
  if (model) args.push("-m", model)
  if (effort) args.push("-c", `model_reasoning_effort="${effort}"`)
  args.push("-") // read the prompt from stdin

  await log(`$ ${bin} ${args.join(" ")}\n`)
  const { stdout, stderr, code } = await runCommand(bin, args, { cwd, stdin: prompt, log, timeoutMs, signal })
  if (signal?.aborted) throw new Error("stopped")
  if (code !== 0) {
    // No JSON envelope here and no turn limit of ours to hit: codex writes its own reason to
    // stderr, so there is nothing to translate the way claude.mjs has to. The one case
    // with nothing to quote is a CLI that died saying nothing — don't report a bare colon.
    const said = (stderr.slice(-800) || stdout.slice(-800)).trim()
    throw new Error(`codex exited with ${code}${said ? `: ${said}` : " without saying why"}`)
  }

  let text = ""
  try {
    text = (await fs.readFile(lastMessageFile, "utf8")).trim()
    await fs.unlink(lastMessageFile).catch(() => {})
  } catch {
    // older codex without -o: fall back to the tail of stdout
    text = stdout.trim().split(/\n{2,}/).pop() ?? ""
  }
  const { reply, actions, decision, problem, plain } = parseReply(text, { trigger: context.run?.trigger, role })
  return { reply, actions, decision, problem, plain, raw: text, summary: reply.slice(0, 300) }
}
