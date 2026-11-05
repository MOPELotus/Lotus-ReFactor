// Yunzai rewrites %zzz... to #绝区零zzz... before Lotus rules run.
// Accept both user input and that normalized form without retaining two labels.
export const ZZZ_COMMAND_PREFIX = "(?:[%％](?:zzz|ZZZ|绝区零)?|[#/](?:zzz|ZZZ|绝区零)(?:zzz|ZZZ|绝区零)?|(?:zzz|ZZZ|绝区零))"
const zzzPrefix = new RegExp(`^${ZZZ_COMMAND_PREFIX}`)

export function normalizeZzzPrefix(message = "", prefix = "#绝区零") {
  return String(message || "").trim().replace(zzzPrefix, prefix)
}
