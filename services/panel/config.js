import { loadGlobalConfig, saveGlobalConfig } from "../../core/config/global.js"
import { GUOBA_SCHEMAS, toGuobaFormData, applyGuobaFormData, getPath } from "../../guoba.support.js"

const secret = schema => schema.component === "InputPassword" || /cookie|stoken|secret|password|token|(?:^|\.)key$/i.test(schema.field || "")
export async function readPanelConfig() {
  const form = toGuobaFormData(await loadGlobalConfig({ createIfMissing: true })), values = {}, configured = []
  for (const schema of GUOBA_SCHEMAS) if (schema.field) {
    const value = getPath(form, schema.field)
    values[schema.field] = secret(schema) ? "" : value
    if (secret(schema) && value) configured.push(schema.field)
  }
  return { schemas: GUOBA_SCHEMAS, values, configured }
}
export async function savePanelConfig(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("配置格式无效")
  const patch = { ...input }
  // A blank password field means keep the existing value. Explicit clearing is
  // a separate field action, so editing unrelated settings never removes keys.
  for (const schema of GUOBA_SCHEMAS) if (schema.field && secret(schema) && patch[schema.field] === "") delete patch[schema.field]
  const clear = Array.isArray(patch.clearSecrets) ? patch.clearSecrets : []
  for (const field of clear) {
    const schema = GUOBA_SCHEMAS.find(s => s.field === field)
    if (!schema || !secret(schema)) throw new Error("清除字段无效")
    patch[field] = ""
  }
  await saveGlobalConfig(applyGuobaFormData(await loadGlobalConfig({ createIfMissing: true }), patch))
  return { ok: true, message: "配置已保存，与锅巴共用；运行实例按功能支持热加载，启动项需重启后生效。" }
}
