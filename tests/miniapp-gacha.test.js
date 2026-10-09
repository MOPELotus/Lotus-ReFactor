import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import YAML from "yaml"
import { MiniappGachaService } from "../services/miniappGacha/service.js"
import { ensureYunzaiConflictDisableConfig } from "../services/intercept/runtime.js"
import { LOTUS_CONFIG_DISABLED_PLUGIN_NAMES } from "../core/intercept/priority.js"

const uid = "123456789"
const profile = { account: { current_uid: { gs: uid }, game_roles: { gs: [{ uid, region: "cn_gf01" }] } } }
const row = (id, extra = {}) => ({ id, uid, gacha_type: "400", name: "测试角色", item_type: "角色", rank_type: "4", time: "2026-10-09 12:00:00", ...extra })
function fixture(list, extra = {}) {
  const stored = { 301: [row("100000000000000001")] }
  const requests = []
  const writes = []
  class Model {
    constructor(e) { assert.equal(e.isSr, false); assert.equal(String(e.user_id), "42") }
    readJson() { return { list: stored[this.type] || [] } }
    writeJson(rows) { writes.push(this.type); stored[this.type] = rows }
  }
  const service = new MiniappGachaService({
    auth: { async getAuthKey(options) { assert.equal(options.profile, profile); return { authkey: "test+key/=", game: "gs", uid, region: "cn_gf01" } } },
    fetch: async (url, options) => { requests.push({ url, options }); return { ok: true, json: async () => ({ list, ...extra }) } },
    loadGachaLog: async () => Model,
  })
  return { service, stored, requests, writes, sync: () => service.sync({ e: { user_id: "42" }, profile, profileId: 2 }) }
}

test("自动凭据请求正确编码，双角色池归并，精确排序并重复同步去重", async () => {
  const f = fixture([row("100000000000000002"), row("100000000000000001")])
  const result = await f.sync()
  assert.deepEqual(result.pools, [{ type: 301, name: "角色", received: 2, added: 1, total: 2 }])
  const request = f.requests[0]
  assert.equal(request.url, "https://www.lelaer.com/outputGacha.php")
  const body = new URLSearchParams(request.options.body)
  assert.equal(body.get("uid"), uid)
  assert.equal(new URL(body.get("gachaurl")).searchParams.get("authkey"), "test+key/=")
  assert.equal(body.has("stoken"), false)
  assert.deepEqual(f.stored[301].map(r => r.id), ["100000000000000002", "100000000000000001"])
  assert.equal((await f.sync()).pools[0].added, 0)
})

test("账号不匹配、畸形记录和接口失败均不写入；空响应保留本地记录", async () => {
  for (const [list, extra] of [[ [row("2"), row("3", { uid: "999999999" })], {} ], [[row("2")], { info: { uid: "999999999" } }], [[row("2", { name: "" })], {}], [[row("2", { gacha_type: "999" })], {}], [undefined, { result: "failed" }]]) {
    const f = fixture(list, extra)
    await assert.rejects(f.sync())
    assert.deepEqual(f.writes, [])
  }
  const f = fixture([])
  assert.deepEqual((await f.sync()).pools, [])
  assert.deepEqual(f.writes, [])
})

test("命令支持 profile 和原别名，不接受手动链接；禁用配置写准确的上游 name", async () => {
  globalThis.plugin = class { constructor(options) { Object.assign(this, options) } }
  const { LotusGachaLog } = await import("../apps/gachaLog.js")
  const rule = new LotusGachaLog().rule.find(r => r.fnc === "miniappGachaLog")
  for (const msg of ["#更新小助手抽卡记录", "#更新小助手抽卡记录2", "#获取提瓦特小助手祈愿历史255"]) assert.match(msg, new RegExp(rule.reg))
  for (const msg of ["#更新小助手抽卡记录 https://example.com", "#更新小助手抽卡记录256"]) assert.doesNotMatch(msg, new RegExp(rule.reg))
  assert.ok(LOTUS_CONFIG_DISABLED_PLUGIN_NAMES.includes("提瓦特小助手抽卡记录"))
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lotus-disable-"))
  try {
    const file = path.join(dir, "group.yaml")
    await fs.writeFile(file, YAML.stringify({ default: { disable: ["已有功能"] }, "123": { disable: ["群配置"] } }))
    await ensureYunzaiConflictDisableConfig({ file })
    const saved = YAML.parse(await fs.readFile(file, "utf8"))
    assert.ok(saved.default.disable.includes("提瓦特小助手抽卡记录"))
    assert.ok(saved.default.disable.includes("已有功能"))
    assert.deepEqual(saved["123"].disable, ["群配置"])
    assert.equal((await ensureYunzaiConflictDisableConfig({ file })).changed, false)
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
})
