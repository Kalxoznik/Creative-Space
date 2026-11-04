import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  // The floating "N" dev-tools button is noise on a board that stays open all day.
  // Build errors still show as an overlay.
  devIndicators: false,
  // The Mac app (`npm run build:app`) ships the self-contained server; `npm run up` and
  // `npm run start` stay as they are. What the tracer drags in besides the server is pruned
  // by scripts/build-app.mjs.
  ...(process.env.CS_STANDALONE ? { output: "standalone" as const } : {}),
}

export default nextConfig
