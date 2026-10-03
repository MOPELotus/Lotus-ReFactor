import { load } from "cheerio"

// Strip presentation markup while retaining the text inside links/terms.
// Game control and gender selectors have a readable, deterministic fallback.
export function plainGameText(value) {
  let text = String(value ?? "")
    .replace(/\{LINK#[^}]+\}|\{\/LINK\}/g, "")
    .replace(/\{TIMEZONE\}/g, "服务器时间")
    .replace(/\{NICKNAME\}/g, "开拓者")
    .replace(/\{F#([^}]+)\}\{M#[^}]+\}/g, "$1")
    .replace(/\{M#([^}]+)\}\{F#[^}]+\}/g, "$1")
    .replace(/\{(?:F|M)#[^}]+\}/g, match => match.slice(3, -1))
    .replace(/\{LAYOUT_CONSOLECONTROLLER#[^}]+\}\{LAYOUT_FALLBACK#([^}]+)\}/g, "$1")
    .replace(/\{LAYOUT_[A-Z_]+#([^}]+)\}/g, "$1")
    .replace(/\{CAL:([^}]+)\}/g, (_, formula) => arithmeticText(formula.split(",")[0]))
    .replace(/#?\{series_ref_skill_desc:[^}]+\}/g, "（关联技能说明暂缺）")
    .replace(/<icon\s+[^>]*SpriteName=[^>]*>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?(?:p|div|h[1-6])(?:\s[^>]*)?>/gi, "\n")
    .replace(/<\/?(?:color(?:=[^>]*)?|size(?:=[^>]*)?|Term(?::[^>]*)?|unbreak|nobr)>/gi, "")
  // Parse tags/entities without allowing resource names to become body text.
  if (/<\/?[A-Za-z][^>]*>|&(?:#\d+|#x[\da-f]+|[a-z]+);/i.test(text)) text = load(text, {}, false).text()
  text = text.replace(/\\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim()
  return /^[.。?？…\s]+$/.test(text) ? "" : text
}

function arithmeticText(expression) {
  if (/AvatarSkillLevel/.test(expression)) return expression.replace(/AvatarSkillLevel\(\d+\)/g, "技能等级").replace(/\*/g, " × ").replace(/\+/g, " + ").replace(/\//g, " ÷ ")
  const tokens = expression.match(/\d+(?:\.\d+)?|[()+*/-]/g) || []
  if (tokens.join("") !== expression.replace(/\s/g, "")) return "随技能效果变化"
  let cursor = 0
  function factor() {
    if (tokens[cursor] === "-") { cursor++; return -factor() }
    if (tokens[cursor] === "+") { cursor++; return factor() }
    if (tokens[cursor] === "(") {
      cursor++; const n = sum()
      if (tokens[cursor++] !== ")") throw new Error("unclosed expression")
      return n
    }
    const token = tokens[cursor++]
    if (!/^\d/.test(token || "")) throw new Error("missing number")
    return Number(token)
  }
  function product() {
    let n = factor()
    while (tokens[cursor] === "*" || tokens[cursor] === "/") {
      const op = tokens[cursor++], rhs = factor()
      n = op === "*" ? n * rhs : n / rhs
    }
    return n
  }
  function sum() {
    let n = product()
    while (tokens[cursor] === "+" || tokens[cursor] === "-") {
      const op = tokens[cursor++], rhs = product()
      n = op === "+" ? n + rhs : n - rhs
    }
    return n
  }
  try {
    const n = sum()
    return cursor === tokens.length && Number.isFinite(n) ? String(Math.round(n * 10000) / 10000) : "随技能效果变化"
  } catch { return "随技能效果变化" }
}
