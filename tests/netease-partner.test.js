import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import YAML from "yaml"
import { NeteasePartnerService, buildPartnerItems, buildPartnerLogMessages } from "../services/neteasePartner/service.js"
import { TuneWeaveService, selectTuneWeaveArtifact } from "../services/tuneweave/service.js"
import { migrateGlobalConfig } from "../core/config/global.js"

async function fixture(run) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lotus-nep-"))
  try { await run(dir) } finally { await fs.rm(dir, { recursive: true, force: true }) }
}
const account = { uid: "123", nickname: "测试账号", tuneweave_account: "lotus-nep-123", extraCount: 2 }
const work = { id: 1, name: "测试作品", supportExtraEvaTypes: ["melody", "vocal", "production"] }

test("合伙人经 TuneWeave 提交全部子项独立评分，额外作品不复用上一首的维度", async () => {
  const submitted = []
  let score = 0
  const tuneweave = { async request(route, options) {
    if (route.startsWith("/v1/account?")) return { authenticated: true, user_id: "123" }
    assert.equal(route, "/v1/extensions/netease/api")
    assert.equal(options.body.account, account.tuneweave_account)
    assert.equal(options.body.crypto, "weapi")
    assert.equal("cookie" in options.body.data, false)
    if (options.body.uri.endsWith("daily/task/get")) return { code: 200, data: { id: 9, works: [{ work }, { work: { id: 3 }, completed: true }] } }
    if (options.body.uri.endsWith("work/list")) return { code: 200, data: [{ work: { id: 2, name: "额外作品", supportExtraEvaTypes: [7] } }] }
    submitted.push(options.body.data)
    return { code: 200 }
  } }
  const service = new NeteasePartnerService({ tuneweave, sleep: async () => {}, scorer: () => ++score })
  const result = await service.executeAccount(account, { comments: ["乐评", "另一条乐评"], delay_ms_min: 0, delay_ms_max: 0 })
  assert.equal(result.success, 3)
  assert.equal(result.skip, 1)
  assert.deepEqual(JSON.parse(submitted[0].extraScore), { melody: 2, vocal: 3, production: 4 })
  assert.equal(submitted[0].score, 1)
  assert.ok(["乐评", "另一条乐评"].includes(submitted[0].comment))
  assert.notEqual(submitted[0].comment, submitted[1].comment)
  assert.equal(result.evaluations[0].comment, submitted[0].comment)
  assert.deepEqual(Object.keys(JSON.parse(submitted[1].extraScore)), ["7"])
  assert.equal(submitted[1].extraResource, "true")
  assert.equal(result.evaluations[0].dimensions.length, 3)
  assert.deepEqual(buildPartnerItems({ accounts: [result] }), [{ label: "测试账号", value: "成功 3 · 失败 17" }])
  assert.ok(buildPartnerLogMessages({ accounts: [result] }).some(text => text.includes("melody:2 / vocal:3 / production:4") && text.includes(submitted[0].comment)))
})

test("旧账号与 TuneWeave 启动账户核对身份，随后仅保存账户别名", async () => fixture(async dir => {
  const file = path.join(dir, "accounts.yaml")
  await fs.writeFile(file, YAML.stringify({ accounts: [{ uid: "123", cookie: "MUSIC_U=test; Path=/", nickname: "旧账号" }] }))
  const calls = []
  const service = new NeteasePartnerService({ accountsFile: file, tuneweave: { async request(route, options) {
    calls.push({ route, options }); return { authenticated: true, user_id: "123", nickname: "迁移账号" }
  } } })
  const migrated = await service.migrateAccount((await service.loadAccounts())[0])
  assert.equal(calls[0].route, "/v1/account?platform=netease&account=default")
  assert.equal(migrated.tuneweave_account, "default")
  assert.equal("cookie" in migrated, false)
  assert.equal((await fs.readFile(file, "utf8")).includes("MUSIC_U"), false)
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600)
}))

test("账号身份不匹配时不评分；TuneWeave 业务错误不会伪装成成功或泄露正文", async () => {
  const service = new NeteasePartnerService({ sleep: async () => {}, tuneweave: { request: async () => ({ authenticated: true, user_id: "other" }) } })
  assert.equal((await service.executeAccount(account)).fail, 20)
  const api = new TuneWeaveService({ fetch: async () => ({ ok: false, status: 401, json: async () => ({ ok: false, error: { code: "authentication_required", message: "MUSIC_U=private" } }) }) })
  await assert.rejects(api.request("/healthz"), error => error.message.includes("authentication_required") && !error.message.includes("private"))
})

test("登录使用 TuneWeave 服务端事务，不向 Lotus 返回 Cookie", async () => fixture(async dir => {
  const calls = []
  const service = new NeteasePartnerService({ accountsFile: path.join(dir, "accounts.yaml"), tuneweave: {
    requireReady: async () => {},
    async request(route, options) {
      calls.push({ route, options })
      if (route === "/v1/auth/qr") return { transaction_id: "transaction", url: "https://music.163.com/login", image_data_url: "data:image/png;base64,test" }
      return { state: "confirmed", profile: { authenticated: true, user_id: "123", nickname: "登录账号" } }
    },
  } })
  const qr = await service.createQrLogin("42")
  assert.equal(calls[0].options.body.credential_mode, "server")
  assert.equal(calls[0].options.body.account, "lotus-nep-42")
  const result = await service.waitQrLogin({ key: qr.key, alias: qr.alias, qq: "42" })
  assert.equal(result.account.tuneweave_account, "lotus-nep-42")
  assert.equal(calls[1].route, "/v1/auth/qr/transaction")
}))

test("独立初始化与状态指令、定时任务和主人汇报保持注册，旧 API 配置迁移", async () => {
  globalThis.plugin = class { constructor(options) { Object.assign(this, options) } }
  const { LotusNeteasePartner } = await import("../apps/neteasePartner.js")
  const app = new LotusNeteasePartner()
  for (const [command, fnc] of [["#初始化TuneWeave", "initializeTuneWeave"], ["#TuneWeave状态", "tuneWeaveStatus"], ["#合伙人登录", "partnerLogin"], ["#合伙人测试", "manualTest"], ["#合伙人测试（执行）", "manualTest"]]) {
    assert.equal(app.rule.find(rule => new RegExp(rule.reg).test(command))?.fnc, fnc)
  }
  assert.equal(app.task[0].cron, "0 5 0 * * ? *")
  assert.equal(typeof app.notifyMasters, "function")
  const config = migrateGlobalConfig({ netease_partner: { api_url: "http://old:3000", enable: true, schedule: "0 15 0 * * ? *" } })
  assert.equal(config.tuneweave.api_url, "http://127.0.0.1:7832")
  assert.equal(config.netease_partner.enable, true)
  assert.equal(config.netease_partner.schedule, "0 15 0 * * ? *")
  assert.equal("api_url" in config.netease_partner, false)
})

test("初始化只选择官方 SHA-256 发布物，缺少必要能力不报告就绪", async () => {
  const base = { platform: "linux", architecture: "x86_64", download_url: "https://github.com/MOPELotus/TuneWeave/releases/download/v1/binary", verification: { algorithm: "sha256", checksum_url: "https://github.com/MOPELotus/TuneWeave/releases/download/v1/binary.sha256" } }
  assert.equal(selectTuneWeaveArtifact({ artifacts: [base] }, "linux", "x64"), base)
  assert.throws(() => selectTuneWeaveArtifact({ artifacts: [{ ...base, download_url: "https://other.example/binary" }] }, "linux", "x64"))
  const service = new TuneWeaveService({ fetch: async () => ({ ok: true, json: async () => ({ ok: true, data: { capabilities: ["qr_login"] } }) }) })
  assert.equal((await service.status()).ok, false)
})

test("SHA-256 不匹配时不安装或启动，未初始化时启动不下载", async () => fixture(async dir => {
  let spawned = false
  const artifact = { platform: "linux", architecture: "x86_64", download_url: "https://github.com/MOPELotus/TuneWeave/releases/download/v1/binary", verification: { algorithm: "sha256", checksum_url: "https://github.com/MOPELotus/TuneWeave/releases/download/v1/binary.sha256" } }
  const service = new TuneWeaveService({ root: dir, platform: "linux", arch: "x64", spawn: () => { spawned = true }, fetch: async url => {
    if (url.endsWith("release-manifest.json")) return new Response(JSON.stringify({ artifacts: [artifact] }))
    return new Response(url.endsWith(".sha256") ? "0".repeat(64) : "binary-content")
  } })
  service.status = async () => ({ ok: false, reachable: false })
  assert.deepEqual(await service.resume(), { skipped: true })
  await assert.rejects(service.initialize(), /SHA-256/)
  assert.equal(spawned, false)
  await assert.rejects(fs.access(path.join(dir, "bin", "tuneweave")))
  await assert.rejects(fs.access(path.join(dir, "bin", "tuneweave.download")))
}))

test("手动与定时并发执行时只提交一次任务", async () => fixture(async dir => {
  let submitted = 0
  const file = path.join(dir, "accounts.yaml")
  await fs.writeFile(file, YAML.stringify({ accounts: [account] }))
  const tuneweave = { requireReady: async () => {}, async request(route, options) {
    if (route.startsWith("/v1/account?")) return { authenticated: true, user_id: "123" }
    if (options.body.uri.endsWith("daily/task/get")) return { code: 200, data: { id: 9, works: [{ work }] } }
    if (options.body.uri.endsWith("work/list")) return { code: 200, data: [] }
    submitted++
    return { code: 200 }
  } }
  const options = { tuneweave, accountsFile: file, stateFile: path.join(dir, "state.yaml"), logDir: path.join(dir, "logs"), sleep: async () => {} }
  const [manual, scheduled] = await Promise.all([new NeteasePartnerService(options).executeTask({}, "手动"), new NeteasePartnerService(options).executeTask({}, "定时")])
  assert.equal(submitted, 1)
  assert.equal(manual, scheduled)
}))

test("次日覆盖合伙人日志，移除旧日期报告但保留其他日志", async () => fixture(async dir => {
  await fs.writeFile(path.join(dir, "nep-202610080005.json"), "{}")
  await fs.writeFile(path.join(dir, "other-feature.json"), "{}")
  const service = new NeteasePartnerService({ logDir: dir })
  const today = { time: "2026-10-09T00:05:00+08:00", accounts: [{ success: 5 }] }
  const tomorrow = { time: "2026-10-10T00:05:00+08:00", accounts: [{ success: 5, evaluations: [{ score: 3, extraScore: { 1: 4, 2: 3 } }] }] }
  await service.writeLog(today)
  assert.deepEqual(await service.latestLog(), today)
  await service.writeLog(tomorrow)
  assert.deepEqual(await service.latestLog(), tomorrow)
  assert.deepEqual((await fs.readdir(dir)).sort(), ["nep-latest.json", "other-feature.json"])
}))

test("定时汇报图发送给主人，去重适配器主人映射并排除 stdin", async () => {
  globalThis.plugin = class { constructor(options) { Object.assign(this, options) } }
  const { LotusNeteasePartner } = await import("../apps/neteasePartner.js")
  const app = new LotusNeteasePartner()
  const deliveries = []
  const previous = globalThis.Bot
  globalThis.Bot = { config: { masterQQ: ["42", "stdin"], master: ["bot:42"] }, pickFriend: id => ({ sendMsg: async payload => deliveries.push({ id, payload }) }) }
  app.renderReportImage = async () => Buffer.from("report-image")
  try {
    await app.notifyMasters({ netease_partner: { notify_master: true } }, { accounts: [{ fail: 0 }] })
    assert.equal(deliveries.length, 1)
    assert.equal(String(deliveries[0].id), "42")
    assert.equal(deliveries[0].payload.toString(), "report-image")
  } finally { globalThis.Bot = previous }
})

test("不足 20 首仅重试一轮，跳过已成功作品，最终合并计数与详细乐评日志", async () => {
  for (const failureMode of ["none", "once", "always"]) {
    const completed = new Set()
    const submits = new Map()
    let dailyReads = 0
    const tuneweave = { async request(route, options) {
      if (route.startsWith("/v1/account?")) return { authenticated: true, user_id: "123" }
      const uri = options.body.uri
      const item = id => ({ completed: completed.has(id), work: { id, name: `歌曲 ${id}`, supportExtraEvaTypes: [1, 2, 3] } })
      if (uri.endsWith("daily/task/get")) { dailyReads++; return { code: 200, data: { id: 9, works: Array.from({ length: 5 }, (_, index) => item(index + 1)) } } }
      if (uri.endsWith("work/list")) return { code: 200, data: Array.from({ length: 15 }, (_, index) => item(index + 6)) }
      const data = options.body.data
      const attempts = submits.get(data.workId) || []
      attempts.push(structuredClone(data))
      submits.set(data.workId, attempts)
      if (data.workId === 8 && (failureMode === "always" || (failureMode === "once" && attempts.length === 1))) throw new Error("测试失败")
      assert.equal(completed.has(data.workId), false, "已完成作品不能再评分")
      completed.add(data.workId)
      return { code: 200 }
    } }
    const service = new NeteasePartnerService({ tuneweave, sleep: async () => {}, scorer: () => 4 })
    const report = await service.executeAccount({ ...account, extraCount: 15 }, { comments: Array.from({ length: 20 }, (_, i) => `独立乐评 ${i}`) })
    assert.equal(dailyReads, failureMode === "none" ? 1 : 2)
    assert.equal(report.attempts, failureMode === "none" ? 1 : 2)
    assert.equal(report.success, failureMode === "always" ? 19 : 20)
    assert.equal(report.fail, failureMode === "always" ? 1 : 0)
    assert.equal(submits.get(8).length, failureMode === "none" ? 1 : 2)
    if (failureMode !== "none") assert.deepEqual(submits.get(8)[0], submits.get(8)[1], "重试复用同一主分、子项及乐评")
    assert.equal(new Set([...submits.values()].map(attempts => attempts[0].comment)).size, 20)
    for (const [id, attempts] of submits) if (id !== 8) assert.equal(attempts.length, 1)
    assert.ok(buildPartnerLogMessages({ accounts: [report] }).some(text => text.includes("歌曲：歌曲 8") && text.includes("主分：4") && text.includes("1:4 / 2:4 / 3:4") && text.includes(submits.get(8)[0].comment)))
    assert.equal(buildPartnerItems({ accounts: [report] }).length, 1)
  }
})

test("自动任务状态按日去重，次日恢复执行", async () => fixture(async dir => {
  let date = new Date(2026, 9, 9, 12)
  const service = new NeteasePartnerService({ stateFile: path.join(dir, "state.yaml"), now: () => date })
  assert.equal(await service.hasRunToday(), false)
  await service.markTaskRun()
  assert.equal(await service.hasRunToday(), true)
  date = new Date(2026, 9, 10, 12)
  assert.equal(await service.hasRunToday(), false)
}))
