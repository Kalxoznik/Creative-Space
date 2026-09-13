import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  // The floating "N" dev-tools button is noise on a board that stays open all day.
  // Build errors still show as an overlay.
  devIndicators: false,
}

export default nextConfig
