import fs from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"
import YAML from "yaml"
import { resolveData } from "../../core/path.js"

const file = resolveData("music", "accounts.yaml")
let writing = Promise.resolve()
export async function readMusicAccounts() {
  await writing.catch(() => {})
  try { return YAML.parse(await fs.readFile(file, "utf8"))?.accounts || {} } catch (error) { if (error.code === "ENOENT") return {}; throw error }
}
export function saveMusicAccount(platform, account, options = {}) {
  const result = writing.catch(() => {}).then(async () => {
    let data = {};try { data = YAML.parse(await fs.readFile(file, "utf8")) || {} }catch(error){if(error.code !== "ENOENT")throw error}
    data.accounts ||= {}
    const current = data.accounts[platform]
    if (Object.hasOwn(options, "expected")) {
      const expected = options.expected
      if (expected === null ? current != null : !current || ["alias", "uid", "credential"].some(key => current[key] !== expected[key])) return null
    }
    const changedIdentity = current && ["alias", "uid"].some(key => Object.hasOwn(account, key) && account[key] !== current[key])
    data.accounts[platform] = { ...current, ...account, ...(changedIdentity && !Object.hasOwn(account, "credential") ? { credential: "" } : {}) }
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
    const temp = `${file}.${randomUUID()}.tmp`
    try { await fs.writeFile(temp, YAML.stringify(data), { mode: 0o600, flag: "wx" });await fs.rename(temp, file) }finally{await fs.rm(temp,{force:true})}
    return data.accounts[platform]
  })
  writing = result.then(() => {}, () => {})
  return result
}
