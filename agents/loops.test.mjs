// Loop detection on a live run (`agents/loops.mjs`, BI-120). The streams below have the shape the
// CLIs print — `claude -p --output-format stream-json --verbose` and `codex exec --json` — one
// event per line. The rules under test: the same call three times in a row, the same failure three
// times, and twenty-five calls that only repeat earlier ones each stop a run; a long run that
// keeps reading new files or changing them is never stopped.
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { after, before, describe, it } from "node:test"
import { runCommand } from "./adapters/process.mjs"
import { streamResult } from "./adapters/claude.mjs"
import { codexStreamText } from "./adapters/codex.mjs"
import { claudeSteps, codexSteps, createLoopDetector, loopError, loopNote, loopWatch, watchStream } from "./loops.mjs"

// --- claude stream-json --------------------------------------------------------

const claude = {
  init: () => ({ type: "system", subtype: "init", session_id: "s1", tools: ["Read", "Edit", "Bash"], model: "claude-opus-5-5" }),
  say: (text) => ({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] }, parent_tool_use_id: null }),
  call: (id, name, input) => ({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] },
    parent_tool_use_id: null,
  }),
  result: (id, content, isError = false) => ({
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content, is_error: isError }] },
    parent_tool_use_id: null,
  }),
  done: (result, extra = {}) => ({ type: "result", subtype: "success", is_error: false, num_turns: 12, result, ...extra }),
}

/** One tool call and its result: the two events claude prints for it. */
function claudeTurn(n, name, input, { error = null, output = "ok" } = {}) {
  const id = `toolu_${n}`
  return [claude.call(id, name, input), claude.result(id, error ?? output, error != null)]
}

/** Feed a recorded stream through the watcher as the lines the CLI would print. */
function replay(events, parse) {
  const hits = []
  const watch = watchStream({ parse, onHit: (hit) => hits.push(hit) })
  for (const event of events) watch.onLine(JSON.stringify(event))
  return hits
}

describe("loop detection on a claude stream", () => {
  it("stops the same call made three times in a row", () => {
    const stream = [
      claude.init(),
      ...claudeTurn(1, "Read", { file_path: "src/a.ts" }),
      ...claudeTurn(2, "Bash", { command: "git status", description: "status" }),
      // The same call again, its keys in another order — still the same call.
      ...claudeTurn(3, "Bash", { description: "status", command: "git status" }),
      ...claudeTurn(4, "Bash", { command: "git status", description: "status" }),
      ...claudeTurn(5, "Read", { file_path: "src/b.ts" }),
    ]
    const hits = replay(stream, claudeSteps)
    assert.equal(hits.length, 1, "one hit, the first time the rule fires")
    assert.equal(hits[0].kind, "repeat")
    assert.equal(hits[0].count, 3)
    assert.equal(hits[0].label, "Bash git status")
  })

  it("stops the same failing command with the same error three times, edits in between", () => {
    const failure = (ms) => `Exit code 1\n▶ store\n  ✖ moves the card (${ms}ms)\nnot ok 1 - moves the card\n# duration_ms ${ms}.5`
    const stream = [
      claude.init(),
      ...claudeTurn(1, "Bash", { command: "npm test" }, { error: failure(812) }),
      ...claudeTurn(2, "Edit", { file_path: "src/server/store.ts", old_string: "a", new_string: "b" }),
      ...claudeTurn(3, "Bash", { command: "npm test" }, { error: failure(790) }),
      ...claudeTurn(4, "Edit", { file_path: "src/server/store.ts", old_string: "b", new_string: "c" }),
      ...claudeTurn(5, "Bash", { command: "npm test" }, { error: failure(801) }),
    ]
    const hits = replay(stream, claudeSteps)
    assert.equal(hits.length, 1)
    assert.equal(hits[0].kind, "failing")
    assert.equal(hits[0].label, "Bash npm test")
    assert.match(hits[0].error, /moves the card/)
  })

  it("does not stop a command that fails differently each time — that is a fix in progress", () => {
    const stream = [
      ...claudeTurn(1, "Bash", { command: "npm test" }, { error: "Exit code 1\nnot ok 1 - moves the card" }),
      ...claudeTurn(2, "Edit", { file_path: "a.ts", old_string: "a", new_string: "b" }),
      ...claudeTurn(3, "Bash", { command: "npm test" }, { error: "Exit code 1\nnot ok 4 - counts rounds" }),
      ...claudeTurn(4, "Edit", { file_path: "a.ts", old_string: "b", new_string: "c" }),
      ...claudeTurn(5, "Bash", { command: "npm test" }, { error: "Exit code 1\nnot ok 7 - resets" }),
      ...claudeTurn(6, "Edit", { file_path: "a.ts", old_string: "c", new_string: "d" }),
      ...claudeTurn(7, "Bash", { command: "npm test" }),
    ]
    assert.deepEqual(replay(stream, claudeSteps), [])
  })

  it("stops 25 calls in a row that only repeat earlier ones", () => {
    const stream = [claude.init()]
    const files = ["src/a.ts", "src/b.ts", "src/c.ts"]
    for (let n = 0; n < 40; n += 1) stream.push(...claudeTurn(n, "Read", { file_path: files[n % files.length] }))
    const hits = replay(stream, claudeSteps)
    assert.equal(hits.length, 1)
    assert.equal(hits[0].kind, "idle")
    assert.equal(hits[0].count, 25)
  })

  it("lets a dispatch read for 40 turns — every call is a new one", () => {
    const stream = [claude.init(), claude.say("Reading the queue's cards first.")]
    for (let n = 0; n < 40; n += 1) {
      const tool = ["Read", "Grep", "Glob"][n % 3]
      const input = tool === "Read" ? { file_path: `src/file-${n}.ts` } : { pattern: `needle${n}` }
      stream.push(...claudeTurn(n, tool, input))
    }
    stream.push(claude.done("BI-1 → @coder · M\nACTIONS: {\"assign\": {}}", { num_turns: 41 }))
    assert.deepEqual(replay(stream, claudeSteps), [])
  })

  it("lets a long coder run go on as long as it keeps changing files", () => {
    const stream = [claude.init()]
    // Read the same two files, edit, run the same tests — over and over, 90 calls. The tests pass
    // or fail with a different error every time, and every round changes a file.
    for (let round = 0; round < 30; round += 1) {
      stream.push(...claudeTurn(`${round}r`, "Read", { file_path: "src/server/store.ts" }))
      stream.push(...claudeTurn(`${round}e`, "Edit", { file_path: "src/server/store.ts", old_string: `v${round}`, new_string: `v${round + 1}` }))
      const failing = `not ok - ${["moves", "counts", "resets", "flags", "clears"][round % 5]} the card, round ${"abcdefghijklmnop"[round % 16]}`
      stream.push(...claudeTurn(`${round}t`, "Bash", { command: "npm test" }, round % 2 ? {} : { error: failing }))
    }
    assert.deepEqual(replay(stream, claudeSteps), [])
  })

  // The "same error" key on what a failing `npm test` really prints here: `node --test` with no
  // TTY, a TAP-ish tail of summary counts and the last file's passing tests. Recorded live into a
  // temp dir, so the output is whatever this Node prints, not a hand-written guess at it.
  describe("on a real failing npm test", () => {
    // One repository for every run, as on a card: the stack traces name its paths.
    let dir
    before(async () => {
      dir = await fs.mkdtemp(path.join(os.tmpdir(), "cs-loops-npm-test-"))
      await fs.mkdir(path.join(dir, "agents"))
      await fs.mkdir(path.join(dir, "tests"))
    })
    after(() => fs.rm(dir, { recursive: true, force: true }))

    /** `npm test`'s output with `failing` of six queue tests red and the bounce counted as `got`. */
    async function npmTest(failing, got) {
      const head = 'import assert from "node:assert/strict"\nimport { describe, it } from "node:test"\n'
      await fs.writeFile(
        path.join(dir, "agents", "store.test.mjs"),
        `${head}describe("the run queue", () => {\n` +
          `  for (let i = 1; i <= 6; i++) it("keeps run " + i + " in order", () => { assert.ok(i > ${failing}) })\n})\n`
      )
      await fs.writeFile(
        path.join(dir, "tests", "store-loops.test.mjs"),
        `${head}describe("review rounds", () => {\n` +
          `  it("counts a bounce", () => { assert.equal(${got}, 3) })\n` +
          `  it("resets on Done", () => { assert.ok(true) })\n` +
          `  it("resets on Backlog", () => { assert.ok(true) })\n})\n`
      )
      // Not as a child of this test run: with NODE_TEST_CONTEXT set it would speak the runner's
      // protocol instead of printing what a terminal-less `npm test` prints.
      const env = { ...process.env, FORCE_COLOR: "0" }
      delete env.NODE_TEST_CONTEXT
      const ran = spawnSync(process.execPath, ["--test", "agents/store.test.mjs", "tests/store-loops.test.mjs"], {
        cwd: dir,
        encoding: "utf8",
        env,
      })
      assert.equal(ran.status, 1, "the recorded run really failed")
      return `Exit code 1\n\n> creative-space@0.1.0 test\n> node --test agents/*.test.mjs tests/*.test.mjs\n\n${ran.stdout}${ran.stderr}`
    }

    /** Three failing `npm test` calls with these outputs, an edit between each. */
    function runs(outputs) {
      const stream = [claude.init()]
      outputs.forEach((error, n) => {
        stream.push(...claudeTurn(`${n}t`, "Bash", { command: "npm test" }, { error }))
        stream.push(...claudeTurn(`${n}e`, "Edit", { file_path: "src/server/store.ts", old_string: `v${n}`, new_string: `v${n + 1}` }))
      })
      return replay(stream, claudeSteps)
    }

    it("does not stop a run whose failures go down: 5, then 3, then 1 red", async () => {
      assert.deepEqual(runs([await npmTest(5, 5), await npmTest(3, 5), await npmTest(1, 5)]), [])
    })

    it("does not stop a run whose wrong value changes: got 5, then 4, then 6", async () => {
      assert.deepEqual(runs([await npmTest(3, 5), await npmTest(3, 4), await npmTest(3, 6)]), [])
    })

    it("stops the very same failure three times, whatever the timings say", async () => {
      const hits = runs([await npmTest(3, 4), await npmTest(3, 4), await npmTest(3, 4)])
      assert.equal(hits.length, 1)
      assert.equal(hits[0].kind, "failing")
    })

    // Claude Code cuts a long Bash output and may keep only its start; the failures and counts
    // `node --test` prints at the end are gone, and three different failures read the same.
    it("does not count a cut output: the same start and the same cut, three different failures", async () => {
      const start = (output) => output.split("\n").slice(0, 6).join("\n")
      const outputs = [await npmTest(3, 5), await npmTest(3, 4), await npmTest(3, 6)].map(start)
      assert.equal(runs(outputs).length, 1, "without the marker, these starts are one and the same error")
      assert.deepEqual(runs(outputs.map((text) => `${text}\n\n... [412 lines truncated] ...`)), [])
    })
  })

  it("ignores a subagent's own calls and reads the result event off the stream", () => {
    const sub = (id) => ({ ...claude.call(id, "Bash", { command: "ls" }), parent_tool_use_id: "toolu_task" })
    assert.deepEqual(claudeSteps(sub("x1")), [])
    const events = [claude.init(), claude.say("Done."), claude.done("All set.\nACTIONS: {\"move\": \"review\"}")]
    assert.equal(streamResult(events).result, "All set.\nACTIONS: {\"move\": \"review\"}")
    assert.equal(streamResult([claude.init()]), null)
  })
})

// --- codex --json --------------------------------------------------------------

const codex = {
  started: () => ({ type: "thread.started", thread_id: "th_1" }),
  command: (id, command, exitCode, output = "") => ({
    type: "item.completed",
    item: {
      id,
      type: "command_execution",
      command: `bash -lc '${command}'`,
      aggregated_output: output,
      exit_code: exitCode,
      status: exitCode === 0 ? "completed" : "failed",
    },
  }),
  change: (id, path) => ({
    type: "item.completed",
    item: { id, type: "file_change", changes: [{ path, kind: "update" }], status: "completed" },
  }),
  message: (id, text) => ({ type: "item.completed", item: { id, type: "agent_message", text } }),
}

describe("loop detection on a codex stream", () => {
  it("stops the same failing command three times and names it without the shell wrapper", () => {
    const stream = [
      codex.started(),
      { type: "turn.started" },
      codex.command("i1", "npm run lint", 1, "src/a.ts\n  3:1  error  'x' is never used  no-unused-vars\n"),
      codex.change("i2", "src/a.ts"),
      codex.command("i3", "npm run lint", 1, "src/a.ts\n  3:1  error  'x' is never used  no-unused-vars\n"),
      codex.change("i4", "src/b.ts"),
      codex.command("i5", "npm run lint", 1, "src/a.ts\n  3:1  error  'x' is never used  no-unused-vars\n"),
    ]
    const hits = replay(stream, codexSteps)
    assert.equal(hits.length, 1)
    assert.equal(hits[0].kind, "failing")
    assert.equal(hits[0].label, "npm run lint")
    assert.match(hits[0].error, /never used/)
  })

  it("stops the same command three times in a row even when it passes", () => {
    const stream = [codex.command("i1", "git status", 0), codex.command("i2", "git status", 0), codex.command("i3", "git status", 0)]
    assert.equal(replay(stream, codexSteps)[0]?.kind, "repeat")
  })

  it("lets a run that keeps changing files go on", () => {
    const stream = [codex.started()]
    for (let n = 0; n < 60; n += 1) {
      stream.push(codex.command(`c${n}`, "sed -n 1,80p src/a.ts", 0))
      stream.push(codex.change(`f${n}`, `src/file-${n}.ts`))
    }
    stream.push(codex.message("m1", "Done.\nACTIONS: {\"move\": \"review\"}"))
    assert.deepEqual(replay(stream, codexSteps), [])
  })

  it("turns codex's error events into the ERROR lines its failure reader knows", () => {
    const said = codexStreamText([
      codex.message("m1", "first"),
      { type: "error", message: "stream disconnected" },
      { type: "turn.failed", error: { message: "The 'gpt-x' model is not supported" } },
      codex.message("m2", "last words"),
    ])
    assert.equal(said.errors, "ERROR: stream disconnected\nERROR: The 'gpt-x' model is not supported")
    assert.equal(said.lastMessage, "last words")
  })
})

// --- what the chat says, and stopping a live process -----------------------------

describe("a hit", () => {
  it("says what repeated, the last call, and that it was stopped as a loop", () => {
    const note = loopNote({ kind: "failing", count: 3, label: "Bash npm test", error: "not ok 1 - moves the card" })
    assert.match(note, /The same command failed 3 times with the same error: `Bash npm test` — not ok 1 - moves the card\./)
    assert.match(note, /Stopped as a loop\.$/)
    const error = loopError({ kind: "repeat", count: 3, label: "Bash git status" })
    assert.equal(error.loop.kind, "repeat")
    assert.match(error.message, /`Bash git status`/)
    assert.ok(error.plain)
    // Whose work is in the tree is the worker's to say — an Architect's run never writes there.
    assert.doesNotMatch(`${error.message} ${error.plain}`, /working tree/)
  })

  it("keeps the first hit once a rule has fired", () => {
    const detector = createLoopDetector({ repeats: 2, failures: 3, idleSteps: 25 })
    detector.step({ type: "call", id: 1, tool: "Read", input: { file_path: "a" } })
    const first = detector.step({ type: "call", id: 2, tool: "Read", input: { file_path: "a" } })
    assert.equal(first.kind, "repeat")
    assert.equal(detector.step({ type: "call", id: 3, tool: "Read", input: { file_path: "b" } }), first)
  })

  it("kills a CLI that keeps looping, long before it would end by itself", async () => {
    // A fake CLI: prints the same tool call every 20 ms, for a minute unless killed.
    const script = `
      let n = 0
      const line = (o) => process.stdout.write(JSON.stringify(o) + "\\n")
      setInterval(() => {
        n += 1
        line({ type: "assistant", message: { content: [{ type: "tool_use", id: "t" + n, name: "Bash", input: { command: "npm test" } }] } })
        line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t" + n, content: "Exit code 1\\nnot ok 1", is_error: true }] } })
      }, 20)
      setTimeout(() => process.exit(0), 60000)
    `
    const logged = []
    const watch = loopWatch({ parse: claudeSteps, log: async (text) => logged.push(text) })
    const started = Date.now()
    const { code } = await runCommand(process.execPath, ["-e", script], {
      log: async (text) => logged.push(text),
      signal: watch.signal,
      onLine: watch.onLine,
    })
    assert.ok(Date.now() - started < 10_000, "the loop was not stopped")
    assert.notEqual(code, 0)
    assert.equal(watch.hit?.kind, "repeat")
    assert.ok(logged.some((text) => /stopped as a loop/.test(text)), "the log says why the CLI was killed")
    assert.ok(logged.some((text) => text.startsWith("→ Bash npm test")), "the log has the steps, not the raw JSON")
  })
})
