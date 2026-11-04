// Coder tiers: Fast / Standard / Strong. A tier is a model plus an effort, not a model alone —
// the same model at low and at high effort is two different costs (docs/decisions.md,
// 2026-11-03). The tables are only what the Agents page fills in when a tier is picked; the
// agent's own model and effort are what the worker runs, and both stay editable.
//
// Model names are the ones the installed CLIs accept — how they were found is in
// docs/features/cost-aware-routing.md.

import { AGENT_TIERS, type AgentEffort, type AgentEngine, type AgentTier } from "./types"

export type TierDefaults = { model: string | null; effort: AgentEffort }

export const TIER_DEFAULTS: Record<AgentEngine, Record<AgentTier, TierDefaults>> = {
  // Claude Code takes aliases that always point at the latest of each family.
  claude: {
    fast: { model: "haiku", effort: "low" },
    standard: { model: "sonnet", effort: "medium" },
    strong: { model: "opus", effort: "high" },
  },
  codex: {
    fast: { model: "gpt-6-luna", effort: "low" },
    standard: { model: "gpt-6.1-sol", effort: "medium" },
    strong: { model: "gpt-6-astra", effort: "high" },
  },
  // No model to pick in stub mode; the effort still says which tier it plays.
  stub: {
    fast: { model: null, effort: "low" },
    standard: { model: null, effort: "medium" },
    strong: { model: null, effort: "high" },
  },
}

/**
 * The tier a coder from before tiers gets, read off its effort: the one place this mapping
 * lives — the migration in src/server/db.ts and the tests both call it. No effort (the CLI's
 * default) or one we do not know is Standard, like a new coder.
 */
export function tierForEffort(effort: string | null | undefined): AgentTier {
  if (effort === "low") return "fast"
  if (effort === "high" || effort === "max") return "strong"
  return "standard"
}

export const TIER_LABELS: Record<AgentTier, string> = { fast: "Fast", standard: "Standard", strong: "Strong" }

/**
 * Where a card goes when its coder's check retry failed: the closest higher tier that has a
 * coder on the board — Fast → Standard, or → Strong when there is no Standard coder. One step,
 * never further; null when nothing above `tier` is there (or `tier` is Strong already).
 */
export function nextTierUp(tier: AgentTier | null | undefined, present: Array<AgentTier | null | undefined>): AgentTier | null {
  if (!tier) return null
  const higher = AGENT_TIERS.slice(AGENT_TIERS.indexOf(tier) + 1)
  return higher.find((t) => present.includes(t)) ?? null
}
