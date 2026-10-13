// Lets a plain `node --test` file import the board's TypeScript directly: Node ≥ 22.18 strips
// the types itself, but it does not know the two things a bundler does for us in `src/` — the
// `@/*` alias from tsconfig.json and extensionless imports. Resolving those here is the whole
// reason this file exists; everything else falls through untouched.
//
// Used by `npm test` (`--import ./tests/ts-imports.mjs`), so `tests/*.test.mjs` can exercise
// `src/server/store.ts` the way `agents/*.test.mjs` exercise the worker's modules.
import { register } from "node:module"

register(new URL("./ts-resolve.mjs", import.meta.url))
