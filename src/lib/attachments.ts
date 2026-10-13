// Pasted images are stored as markdown: ![image](/api/uploads/<name>)
export const IMAGE_RE = /!\[[^\]]*\]\((\/api\/uploads\/[a-z0-9]+\.(?:png|jpg|gif|webp))\)/g

/** How many pasted images a piece of text carries — the card's paperclip counter. */
export function countImages(text: string | null | undefined): number {
  if (!text) return 0
  return text.match(IMAGE_RE)?.length ?? 0
}

// A line that holds nothing but images — it goes away whole, newline included,
// so cutting the images out does not leave a blank line behind.
const IMAGE_ONLY_LINE = new RegExp(`^[^\\S\\n]*(?:${IMAGE_RE.source}[^\\S\\n]*)+$\\n?`, "gm")
// A run of images sitting inside a line of text — it takes the spaces glued to it
// along. Adjacent images go as one match, so they cannot leave a double space.
const IMAGE_IN_LINE = new RegExp(`[^\\S\\n]*(?:${IMAGE_RE.source}[^\\S\\n]*)+`, "g")

/**
 * Splits stored text into what the user typed and the URLs of its images, so an
 * editor can show the images as thumbnails instead of raw markdown. Only the
 * whitespace around the removed images is touched — the rest of the text
 * (indentation, code blocks, list nesting) comes back byte for byte.
 */
export function splitImages(text: string | null | undefined): { text: string; images: string[] } {
  if (!text) return { text: "", images: [] }
  const images = Array.from(text.matchAll(IMAGE_RE), (match) => match[1])
  const rest = text
    .replace(IMAGE_ONLY_LINE, "")
    .replace(IMAGE_IN_LINE, (match, _url, offset: number, whole: string) => {
      // Words on both sides still need a space between them; at the end of a
      // line the images just disappear, and at the start of one they leave the
      // line's indentation behind.
      const before = whole[offset - 1]
      const after = whole[offset + match.length]
      if (after === undefined || after === "\n") return ""
      if (before === undefined || before === "\n") return match.match(/^[^\S\n]*/)?.[0] ?? ""
      return " "
    })
    .trim()
  return { text: rest, images }
}

/** The inverse of splitImages: text plus its images back in the stored markdown form. */
export function joinImages(text: string, images: string[]): string {
  const markdown = images.map((url) => `![image](${url})`).join(" ")
  const body = text.trim()
  if (!markdown) return body
  return body ? `${body}\n${markdown}` : markdown
}
