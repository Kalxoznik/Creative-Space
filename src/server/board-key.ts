/**
 * Board keys — the `BI` in `BI-12`.
 *
 * A card's primary key stays `t_…` everywhere (URLs, the API, the database); the key plus
 * the board's own counter only gives people and agents something they can say out loud.
 * Shared by the migration in db.ts and by the board writes in store.ts.
 */

const CYRILLIC: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i",
  й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t",
  у: "u", ф: "f", х: "h", ц: "c", ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "",
  э: "e", ю: "yu", я: "ya",
}

export const BOARD_KEY_MIN = 2
export const BOARD_KEY_MAX = 4

/** Latin letters only, so the key is typeable: «Боард» → "BOARD". */
function transliterate(name: string): string {
  return name
    .toLowerCase()
    .split("")
    .map((char) => CYRILLIC[char] ?? char)
    .join("")
}

/**
 * A key proposal for a board name, unique among `taken`.
 *
 * Several words → their initials ("Backend Infra" → `BI`), one word → its first
 * letters ("Merge" → `MER`). A name with nothing latin left after transliteration falls
 * back to `B`, and the uniqueness pass turns that into `B1`, `B2`, … — which is why a
 * key may hold digits after the first character.
 */
export function suggestBoardKey(name: string, taken: Iterable<string> = []): string {
  const used = new Set(Array.from(taken, (key) => key.toUpperCase()))
  const words = transliterate(name).match(/[a-z]+/g) ?? []
  let base = ""
  if (words.length >= 2) base = words.slice(0, BOARD_KEY_MAX).map((word) => word[0]).join("")
  else if (words.length === 1) base = words[0].slice(0, 3)
  base = base.toUpperCase().slice(0, BOARD_KEY_MAX) || "B"

  if (!used.has(base) && base.length >= BOARD_KEY_MIN) return base
  // `B` → `B1`; `BI` taken → `BI2`, `BI3`, … and a 4-char base gives up a letter to fit.
  const stem = base.slice(0, BOARD_KEY_MAX - 1)
  for (let n = base.length < BOARD_KEY_MIN ? 1 : 2; n < 1000; n += 1) {
    const candidate = `${stem}${n}`.slice(0, BOARD_KEY_MAX)
    if (!used.has(candidate)) return candidate
  }
  return base
}

/**
 * A key typed by hand in the board settings. Throws the message the form shows when the
 * value cannot be used at all.
 */
export function normalizeBoardKey(raw: string): string {
  const key = raw.trim().toUpperCase().replace(/[^A-Z0-9]/g, "")
  if (key.length < BOARD_KEY_MIN || key.length > BOARD_KEY_MAX || !/^[A-Z]/.test(key)) {
    throw new Error(
      `Board key must be ${BOARD_KEY_MIN}–${BOARD_KEY_MAX} characters, letters and digits, starting with a letter`
    )
  }
  return key
}
