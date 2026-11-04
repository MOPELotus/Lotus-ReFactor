export function deviceAndroidVersion(info = {}) {
  for (const value of [info.android_version, info.osVersion, info.androidVersion,
    info.raw?.android_version, info.raw?.osVersion, info.raw?.androidVersion]) {
    if ((typeof value === "string" || typeof value === "number") && String(value).trim()) return String(value).trim()
  }
  return ""
}
