import crypto from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { NotFoundError, ValidationError } from "./store"

// Pasted images live in uploads/ next to the project (git-ignored).
// Text references them as ![image](/api/uploads/<name>); agents get the file path.
export const UPLOADS_DIR = process.env.CS_UPLOADS_DIR ?? path.join(process.cwd(), "uploads")

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024

const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
}

const CONTENT_TYPES = Object.fromEntries(Object.entries(EXTENSIONS).map(([type, ext]) => [ext, type]))

const NAME_RE = /^[a-z0-9]+\.(png|jpg|gif|webp)$/

export async function saveImage(file: unknown): Promise<{ name: string; url: string; path: string }> {
  if (!(file instanceof Blob)) throw new ValidationError("file is required")
  const ext = EXTENSIONS[file.type]
  if (!ext) throw new ValidationError("Only PNG, JPEG, GIF and WebP images are supported")
  if (file.size > MAX_UPLOAD_BYTES) throw new ValidationError("Image is larger than 10 MB")

  const name = `${Date.now().toString(36)}${crypto.randomBytes(6).toString("hex")}.${ext}`
  const filePath = path.join(UPLOADS_DIR, name)
  await fs.mkdir(UPLOADS_DIR, { recursive: true })
  await fs.writeFile(filePath, Buffer.from(await file.arrayBuffer()))
  return { name, url: `/api/uploads/${name}`, path: filePath }
}

export async function readImage(name: string): Promise<{ data: Buffer; contentType: string }> {
  if (!NAME_RE.test(name)) throw new NotFoundError("Image not found")
  try {
    const data = await fs.readFile(path.join(UPLOADS_DIR, name))
    return { data, contentType: CONTENT_TYPES[name.split(".").pop() ?? ""] }
  } catch {
    throw new NotFoundError("Image not found")
  }
}
