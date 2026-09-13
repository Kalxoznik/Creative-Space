import { handle } from "@/server/http"
import { readImage } from "@/server/uploads"

export const dynamic = "force-dynamic"

type Ctx = { params: Promise<{ name: string }> }

export const GET = handle(async (_request: Request, ctx: Ctx) => {
  const { name } = await ctx.params
  const { data, contentType } = await readImage(name)
  return new Response(new Uint8Array(data), {
    headers: {
      "Content-Type": contentType,
      // Names are random and never reused, so the file behind a URL never changes.
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  })
})
