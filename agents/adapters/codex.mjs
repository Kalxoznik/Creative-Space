// Codex CLI adapter — non-interactive `codex exec`. Used for the Coder: it may
// edit files and commit inside the repository (workspace-write sandbox).
//
// Requires Codex CLI installed and logged in on this machine:
//   npm i -g @openai/codex   →   codex login
// Override the binary with CS_CODEX_BIN.

import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { runCommand } from "./process.mjs"
import { buildPrompt, parseReply, PROJECT_ROOT } from "../lib.mjs"

export async function runCodex(role, context, { log, timeoutMs }) {
  const prompt = await buildPrompt(role, context)
  const cwd = context.board.repoPath ?? PROJECT_ROOT
  const bin = process.env.CS_CODEX_BIN ?? "codex"
  const model = process.env.CS_CODEX_MODEL
  const lastMessageFile = path.join(os.tmpdir(), `cs-codex-${context.run.id}.txt`)
  const args = ["exec", "--full-auto", "--skip-git-repo-check", "-C", cwd, "-o", lastMessageFile]
  if (model) args.push("-m", model)
  args.push("-") // read the prompt from stdin

  await log(`$ ${bin} ${args.join(" ")}\n`)
  const { stdout, stderr, code } = await runCommand(bin, args, { cwd, stdin: prompt, log, timeoutMs })
  if (code !== 0) {
    throw new Error(`codex exited with ${code}: ${stderr.slice(-800) || stdout.slice(-800)}`)
  }

  let text = ""
  try {
    text = (await fs.readFile(lastMessageFile, "utf8")).trim()
    await fs.unlink(lastMessageFile).catch(() => {})
  } catch {
    // older codex without -o: fall back to the tail of stdout
    text = stdout.trim().split(/\n{2,}/).pop() ?? ""
  }
  const { reply, actions } = parseReply(text)
  return { reply, actions, summary: reply.slice(0, 300) }
}
