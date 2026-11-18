import fs from "node:fs"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { setTimeout as sleep } from "node:timers/promises"
import { createProfileRequestGuard } from "../../core/login/requestGuard.js"
import { AuthKeyService, buildGachaLogUrl } from "../mihoyoAuthKey/service.js"
import { importRuntimeModule, pickRole, getRoleUid } from "../pluginBridge/common.js"
import { gachaRecordId, mergeGachaRecords } from "./records.js"

const POOLS = [[301, "角色"], [302, "武器"], [500, "集录"], [200, "常驻"]]
const running = new Set()

export class GenshinGachaService {
  constructor(options = {}) {
    this.fetch = options.fetch || globalThis.fetch
    this.auth = options.auth || new AuthKeyService({ fetch: this.fetch })
    this.loadModel = options.loadModel || (async () => (await importRuntimeModule("genshin", "model", "gachaLog.js")).default)
    this.sleep = options.sleep || sleep
    this.maxPages = options.maxPages ?? 1000
  }

  async sync({ e, profile, profileId = 1 }) {
    const role = pickRole(profile, "gs")
    const uid = getRoleUid(role)
    if (!uid) return { skipped: true, profileId, game: "gs" }
    const qq = String(e.user_id)
    const key = JSON.stringify([qq, uid])
    if (running.has(key)) throw new Error("该账号的原神抽卡记录正在更新，请稍后再试。")
    running.add(key)
    try {
      let guard = createProfileRequestGuard(profile)
      const auth = await this.auth.getAuthKeyForProfile({
        qq, profileId, profile, game: "gs", uid, region: role.region,
        onRefreshedProfile: async updated => { guard = createProfileRequestGuard(updated); await guard?.() },
        beforeRequest: async () => guard?.(),
      })
      const url = new URL(buildGachaLogUrl(auth))
      const Model = await this.loadModel()
      const model = new Model({ ...e, user_id: qq, uid, isSr: false, game: "gs", msg: "#更新抽卡记录" })
      model.uid = uid
      const snapshots = []
      for (const [type, name] of POOLS) {
        snapshots.push({ type, name, records: await this.scanPool(url, { type, name, uid, guard }) })
      }
      await guard?.()
      // Read the latest local files only after fetching. A failed scan never writes any pool.
      const results = snapshots.map(({ type, name, records }) => {
        model.type = type
        const previous = model.readJson().list
        const merged = mergeGachaRecords(previous, records)
        const previousIds = new Set(previous.map(gachaRecordId))
        return { type, name, added: merged.filter(row => !previousIds.has(gachaRecordId(row))).length, merged, previous }
      })
      for (const { type, merged, previous } of results) {
        if (merged.every((row, i) => row === previous[i]) && merged.length === previous.length) continue
        writePool(path.join(model.path, uid, `${type}.json`), merged)
      }
      // Keep the bindings native export and other genshin commands expect.
      if (results.some(({ merged }) => merged.length) && globalThis.redis?.setEx) {
        await globalThis.redis.setEx(model.uidKey, 30 * 24 * 3600, uid)
        await globalThis.redis.setEx(`${model.urlKey}${uid}`, 86400, auth.authkey)
      }
      const pools = results.map(({ type, name, added, merged }) => ({ type, name, added, total: merged.length }))
      return { ok: true, profileId, game: "gs", uid, region: auth.region, pools }
    } finally {
      running.delete(key)
    }
  }

  async scanPool(base, { type, name, uid, guard }) {
    const url = new URL(base)
    const records = []
    const cursors = new Set(["0"])
    let cursor = "0"
    for (let page = 1; page <= this.maxPages; page++) {
      await this.sleep(1000)
      await guard?.()
      for (const [key, value] of Object.entries({ gacha_type: type, page, size: 20, end_id: cursor })) {
        url.searchParams.set(key, String(value))
      }
      let response
      try { response = await this.fetch(url, { signal: AbortSignal.timeout(30_000) }) }
      catch { throw new Error(`原神${name}池请求失败，请稍后重试。`) }
      if (!response.ok) throw new Error(`原神${name}池请求失败：HTTP ${response.status}`)
      const data = await response.json().catch(() => null)
      if (data?.retcode !== 0 || !Array.isArray(data.data?.list)) {
        throw new Error(`原神${name}池返回异常（${Number.isSafeInteger(data?.retcode) ? data.retcode : "数据无效"}），本次未写入记录。`)
      }
      const list = data.data.list
      if (!list.length) return records
      for (const row of list) {
        if (!row || String(row.uid) !== uid || ![type, ...(type === 301 ? [400] : [])].includes(Number(row.gacha_type))) {
          throw new Error(`原神${name}池返回了其他账号或卡池的记录，本次未写入记录。`)
        }
        gachaRecordId(row)
        records.push(row)
      }
      const next = gachaRecordId(list.at(-1))
      if (cursors.has(next) || BigInt(next) === 0n || (cursor !== "0" && BigInt(next) >= BigInt(cursor))) {
        throw new Error(`原神${name}池分页游标异常，本次未写入记录。`)
      }
      cursors.add(next)
      cursor = next
    }
    throw new Error(`原神${name}池分页超过上限，本次未写入记录。`)
  }
}

function writePool(file, records) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${randomUUID()}.tmp`
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(records, null, "\t")}\n`, { mode: 0o600 })
    fs.renameSync(tmp, file)
  } finally {
    fs.rmSync(tmp, { force: true })
  }
}
