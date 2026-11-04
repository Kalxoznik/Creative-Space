// Coder tiers (docs/features/cost-aware-routing.md, item 1). The rules under test: a coder from
// before tiers gets one read off its effort, by the same function the migration calls; a coder
// always has a tier and an architect never does; and the tier goes in and comes back out of
// the store unchanged, a bad one refused.
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { after, before, describe, it } from "node:test"

let dir
let db
let store
let tiers

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-tiers-"))
  process.env.CS_DB_PATH = path.join(dir, "board.db")
  db = await import("../src/server/db.ts")
  store = await import("../src/server/store.ts")
  tiers = await import("../src/lib/tiers.ts")
})

after(() => fs.rmSync(dir, { recursive: true, force: true }))

const agent = (id) => store.listMembers().find((m) => m.id === id)

describe("effort → tier", () => {
  it("maps low, medium, high, max and none", () => {
    assert.equal(tiers.tierForEffort("low"), "fast")
    assert.equal(tiers.tierForEffort("medium"), "standard")
    assert.equal(tiers.tierForEffort("high"), "strong")
    assert.equal(tiers.tierForEffort("max"), "strong")
    assert.equal(tiers.tierForEffort(null), "standard")
    assert.equal(tiers.tierForEffort(undefined), "standard")
  })

  it("fills the tier of coders in a database from before tiers, and leaves architects without one", () => {
    const file = path.join(dir, "before-tiers.db")
    const old = new DatabaseSync(file)
    old.exec(`CREATE TABLE members (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, handle TEXT NOT NULL UNIQUE, initials TEXT NOT NULL,
      tone TEXT NOT NULL DEFAULT 'amber', kind TEXT NOT NULL DEFAULT 'human', agent_role TEXT, effort TEXT
    )`)
    const insert = old.prepare(
      "INSERT INTO members (id, name, handle, initials, kind, agent_role, effort) VALUES (?, ?, ?, 'X', ?, ?, ?)"
    )
    insert.run("me", "Me", "me", "human", null, null)
    insert.run("c_low", "Low", "c_low", "agent", "coder", "low")
    insert.run("c_medium", "Medium", "c_medium", "agent", "coder", "medium")
    insert.run("c_high", "High", "c_high", "agent", "coder", "high")
    insert.run("c_max", "Max", "c_max", "agent", "coder", "max")
    insert.run("c_none", "None", "c_none", "agent", "coder", null)
    insert.run("arch", "Arch", "arch", "agent", "architect", "max")
    old.close()

    db.openAt(file).close()

    const handle = new DatabaseSync(file)
    const tierOf = Object.fromEntries(
      handle.prepare("SELECT id, tier FROM members").all().map((row) => [row.id, row.tier])
    )
    handle.close()
    assert.deepEqual(tierOf, {
      me: null,
      c_low: "fast",
      c_medium: "standard",
      c_high: "strong",
      c_max: "strong",
      c_none: "standard",
      arch: null,
    })
  })
})

describe("the tier in the store", () => {
  it("is Standard for a new coder and none for a new architect", () => {
    assert.equal(store.createAgent({ name: "Plain coder", role: "coder" }).agent.tier, "standard")
    assert.equal(store.createAgent({ name: "Planner", role: "architect", tier: "strong" }).agent.tier, null)
    // The seeded coder is a coder like any other.
    assert.equal(agent("coder").agent.tier, "standard")
  })

  it("round-trips through create, update and the agent list", () => {
    const created = store.createAgent({ name: "Quick", role: "coder", tier: "fast", model: "haiku", effort: "low" })
    assert.equal(created.agent.tier, "fast")
    assert.equal(store.listAgents().find((a) => a.id === created.id).agent.tier, "fast")

    const updated = store.updateAgent(created.id, { tier: "strong" })
    assert.equal(updated.agent.tier, "strong")
    // The tier is its own field: model and effort stay what they were.
    assert.equal(updated.agent.model, "haiku")
    assert.equal(updated.agent.effort, "low")
    assert.equal(agent(created.id).agent.tier, "strong")
  })

  it("follows the role: none as an architect, read off the effort as a coder again", () => {
    const coder = store.createAgent({ name: "Switcher", role: "coder", tier: "fast", effort: "high" })
    assert.equal(store.updateAgent(coder.id, { role: "architect" }).agent.tier, null)
    assert.equal(store.updateAgent(coder.id, { role: "coder" }).agent.tier, "strong")
  })

  it("refuses a tier it does not know", () => {
    assert.throws(() => store.createAgent({ name: "Bad", role: "coder", tier: "turbo" }), store.ValidationError)
    assert.throws(() => store.updateAgent("coder", { tier: 3 }), store.ValidationError)
    assert.equal(agent("coder").agent.tier, "standard")
  })
})
