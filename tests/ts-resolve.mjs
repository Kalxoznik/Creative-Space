// The resolve hook registered by ts-imports.mjs. See that file for why.
import fs from "node:fs"
import { fileURLToPath } from "node:url"

const SRC = new URL("../src/", import.meta.url)
const CANDIDATES = [".ts", ".tsx", "/index.ts", "/index.tsx"]

export function resolve(specifier, context, next) {
  const spec = specifier.startsWith("@/") ? new URL(specifier.slice(2), SRC).href : specifier
  if (spec.startsWith("@/") || spec.startsWith(".") || spec.startsWith("file:")) {
    const parent = spec.startsWith("file:") ? undefined : context.parentURL
    const url = new URL(spec, parent)
    if (!fs.existsSync(fileURLToPath(url))) {
      for (const ext of CANDIDATES) {
        const candidate = new URL(url.href + ext)
        if (fs.existsSync(fileURLToPath(candidate))) return next(candidate.href, context)
      }
    }
  }
  return next(spec, context)
}
