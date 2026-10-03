import { createRequire } from "node:module"

// Miao character IDs also cover API responses that omit name_mi18n.
const names = createRequire(import.meta.url)("../../resources/starrail-abyss/characters.json")

export function starRailCharacterName(id) {
  return names[String(id)] || ""
}
