/** `BI` + 12 → `BI-12`: the card number people and agents say out loud. Used on both sides. */
export function taskRef(boardKey: string | null | undefined, number: number | null | undefined): string | null {
  if (!boardKey || !number) return null
  return `${boardKey}-${number}`
}
