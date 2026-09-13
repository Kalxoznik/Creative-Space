import { handle, json } from "@/server/http"
import { ValidationError } from "@/server/store"
import { saveImage } from "@/server/uploads"

export const dynamic = "force-dynamic"

export const POST = handle(async (request: Request) => {
  let form: FormData
  try {
    form = await request.formData()
  } catch {
    throw new ValidationError("Expected multipart form data")
  }
  const saved = await saveImage(form.get("file"))
  return json(saved, { status: 201 })
})
