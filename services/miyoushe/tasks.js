import { setTimeout as sleep } from "node:timers/promises"
import { MiyousheClient, BBS, withMiyousheAccount } from "./client.js"
import { requiresMiyousheCaptcha } from "./captcha.js"
import { isAccountChangedError } from "../../core/login/account.js"

const api = "https://api-takumi.mihoyo.com"
export const SIGNIN_GAMES = [
  { key: "genshin", name: "原神", biz: "hk4e_cn", act: "e202311201442471", signgame: "hk4e", osAct: "e202102251931481", osBase: "https://sg-hk4e-api.hoyolab.com/event/sol" },
  { key: "honkai_sr", name: "星铁", biz: "hkrpg_cn", act: "e202304121516551", signgame: "hkrpg", base: `${api}/event/luna/hkrpg`, osAct: "e202303301540311", osBase: "https://sg-public-api.hoyolab.com/event/luna/os", osSigngame: "hkrpg" },
  { key: "zzz", name: "绝区零", biz: "nap_cn", act: "e202406242138391", signgame: "zzz", base: "https://act-nap-api.mihoyo.com/event/luna/zzz", osAct: "e202406031448091", osBase: "https://sg-act-nap-api.hoyolab.com/event/luna/zzz/os" },
  { key: "honkai2", name: "崩坏2", biz: "bh2_cn", act: "e202203291431091" },
  { key: "honkai3rd", name: "崩坏3", biz: "bh3_cn", act: "e202306201626331", osAct: "e202110291205111", osBase: "https://sg-public-api.hoyolab.com/event/mani", osSigngame: "bh3" },
  { key: "tears_of_themis", name: "未定事件簿", biz: "nxx_cn", act: "e202202251749321", osAct: "e202202281857121", osBase: "https://sg-public-api.hoyolab.com/event/luna/os", osSigngame: "nxx" },
]
const forums = { 1: ["崩坏3", 1], 2: ["原神", 26], 3: ["崩坏2", 30], 4: ["未定事件簿", 37], 5: ["大别野", 34], 6: ["星铁", 52], 8: ["绝区零", 57], 9: ["因缘精灵", 948], 10: ["星布谷地", 950] }

export class MiyousheTasks {
  constructor(options = {}) { this.client = options.client || new MiyousheClient(options); this.sleep = options.sleep || (() => sleep(3000 + Math.random() * 2000)) }

  async runProfile(profile, options = {}) {
    return withMiyousheAccount(profile, async () => {
      const tasks = [], events = []
      const requestOptions = { onCaptchaEvent: options.onCaptchaEvent, signal: options.signal, beforeRequest: options.beforeRequest }
      const sendRequest = (url, selectedProfile, config = {}) => this.client.request(url, selectedProfile, { ...requestOptions, ...config })
      const run = async (kind, key, label, work) => {
        let row
        try { options.signal?.throwIfAborted(); row = { kind, key, label, status: "success", ...(await work()) }; options.signal?.throwIfAborted() }
        catch (error) { options.signal?.throwIfAborted(); if (isAccountChangedError(error)) throw error; row = { kind, key, label, status: "failed", message: error.message } }
        tasks.push(row); events.push({ type: "task:result", ...row }); return row
      }
      for (const side of ["cn", "os"]) {
        const cfg = profile.games?.[side]
        if (!cfg?.enable) continue
        for (const game of SIGNIN_GAMES) {
          if (!cfg[game.key]?.checkin) continue
          if (side === "os" && !game.osAct) continue
          if (side === "os") {
            await run("game_os", game.key, `${game.name}国际服`, async () => {
              if (!cfg.cookie) throw new Error("未配置 HoYoLAB Cookie")
              const p = { ...profile, account: { cookie: cfg.cookie } }
              const args = { act_id: game.osAct, lang: cfg.lang || "zh-cn" }
              const headers = { Cookie: cfg.cookie, Origin: "https://act.hoyolab.com", Referer: "https://act.hoyolab.com/", "x-rpc-signgame": game.osSigngame || game.signgame || "" }
              const info = await sendRequest(`${game.osBase}/info`, p, { params: args, headers, overseas: true, captcha: false })
              this.client.assert(info)
              if (info.data?.is_sign) return { status: "already", message: "今日已签到" }
              if (info.data?.first_bind) throw new Error("首次绑定，请先在 HoYoLAB 手动签到一次")
              const result = await sendRequest(`${game.osBase}/sign`, p, { method: "POST", params: { lang: args.lang }, body: { act_id: args.act_id }, headers, overseas: true, captcha: ["genshin", "honkai_sr", "zzz"].includes(game.key), game: game.key, onCaptchaEvent: options.onCaptchaEvent })
              this.client.assert(result)
              const checked = this.client.assert(await sendRequest(`${game.osBase}/info`, p, { params: args, headers, overseas: true, captcha: false }))
              if (!checked?.is_sign) throw new Error("提交后未确认签到状态；若触发验证请在 HoYoLAB 完成")
              return { message: "已确认签到" }
            })
          } else {
            const roles = await run("roles", game.key, `${game.name}角色查询`, async () => ({ roles: this.client.assert(await sendRequest(`${api}/binding/api/getUserGameRolesByCookie`, profile, { params: { game_biz: game.biz }, web: true })).list || [] }))
            if (roles.status === "failed") continue
            tasks.pop(); events.pop()
            const eligible = roles.roles.filter(role => !(cfg[game.key].black_list || []).map(String).includes(String(role.game_uid)))
            if (!eligible.length) { tasks.push({ kind: "game", key: game.key, label: game.name, status: "skipped", message: "无可签到角色" }); continue }
            for (const role of eligible) await run("game", game.key, `${game.name} ${role.game_uid}`, async () => {
              const base = game.base || `${api}/event/luna`, args = { act_id: game.act, uid: role.game_uid, region: role.region, lang: "zh-cn" }
              const headers = game.signgame ? { "x-rpc-signgame": game.signgame } : {}
              const info = this.client.assert(await sendRequest(`${base}/info`, profile, { params: args, web: true, headers, game: game.key }))
              if (info.is_sign) return { status: "already", message: "今日已签到" }
              if (info.first_bind) throw new Error("首次绑定，请先在米游社手动签到一次")
              const result = await sendRequest(`${base}/sign`, profile, { method: "POST", body: { act_id: game.act, uid: role.game_uid, region: role.region }, web: true, headers, game: game.key, onCaptchaEvent: options.onCaptchaEvent })
              this.client.assert(result)
              if (requiresMiyousheCaptcha(result)) throw new Error("签到仍要求验证码")
              const checked = this.client.assert(await sendRequest(`${base}/info`, profile, { params: args, web: true, headers, game: game.key }))
              if (!checked?.is_sign) throw new Error("提交后未确认签到状态")
              return { message: "已确认签到" }
            })
          }
          await this.sleep()
        }
        if (cfg.hna?.checkin) tasks.push({ kind: "game", key: "hna", label: "因缘精灵", status: "skipped", message: "暂无经核实的游戏签到活动，社区签到独立执行" })
      }
      const cloudGames = [
        { side: "cn", key: "genshin", url: "https://api-cloudgame.mihoyo.com/hk4e_cg_cn/wallet/wallet/get" },
        { side: "cn", key: "zzz", url: "https://cg-nap-api.mihoyo.com/nap_cn/cg/wallet/wallet/get" },
        { side: "os", key: "genshin", url: "https://sg-cg-api.hoyoverse.com/hk4e_global/cg/wallet/wallet/get" },
      ]
      for (const { side, key, url } of cloudGames) {
        const group = profile.cloud_games?.[side], cfg = group?.[key]
        if (group?.enable === false) continue
        if (cfg?.enable) await run("cloud", `${side}:${key}`, `云${key === "zzz" ? "绝区零" : "原神"}${side === "os" ? "国际服" : ""}`, async () => {
          if (!cfg.token) throw new Error("缺少该云游戏的 combo_token")
          const headers = { Cookie: "", Referer: "https://app.mihoyo.com", "x-rpc-combo_token": cfg.token,
            ...(side === "os" ? { "x-rpc-client_type": "3", "x-rpc-cg_game_biz": "hk4e_global", "x-rpc-channel_id": "1", "x-rpc-language": group.lang || "zh-cn" } : {}) }
          const data = this.client.assert(await sendRequest(url, profile, { headers, overseas: side === "os", captcha: false }))
          return { message: `钱包查询成功，免费时长 ${data.free_time?.free_time ?? "未知"} 分钟；本次赠送 ${data.free_time?.send_freetime ?? "未知"} 分钟` }
        })
      }
      let before, after
      if (profile.mihoyobbs?.enable) {
        const cfg = profile.mihoyobbs, enabled = cfg.tasks || cfg
        const state = await run("missions", "before", "社区任务状态", async () => ({ data: await this.client.missions(profile, requestOptions) }))
        before = state.data
        if (state.status !== "failed" && profile.device?.id && profile.device?.fp) {
          if (enabled.checkin) for (const id of cfg.checkin_list || []) {
            if (!forums[id]) continue
            await run("community", String(id), `${forums[id][0]}社区`, async () => {
              const r = await sendRequest(`${BBS.origin}/apihub/app/api/signIn`, profile, { method: "POST", body: { gids: String(id) }, stoken: true, x6: true, onCaptchaEvent: options.onCaptchaEvent })
              if (r.retcode === 1008 || /已签到/.test(r.message)) return { status: "already", message: "今日已签到" }
              this.client.assert(r); return { message: "社区签到请求成功；米游币以任务回读为准" }
            }); await this.sleep()
          }
          const states = Array.isArray(before.states) ? before.states : []
          const pending = [["read", 59], ["like", 60], ["share", 61]].filter(([key, id]) => enabled[key] && states.some(s => Number(s.mission_id) === id && !s.is_get_award))
          if (pending.length) {
            const forumId = (cfg.checkin_list || []).find(id => forums[id])
            const posts = await run("posts", "list", "社区帖子查询", async () => {
              if (!forumId) throw new Error("未选择有效社区分区")
              return { posts: this.client.assert(await sendRequest(`${BBS.origin}/post/api/getForumPostList`, profile, { params: { forum_id: forums[forumId][1], is_good: false, is_hot: false, page_size: 20, sort_type: 1 }, stoken: true })).list || [] }
            })
            for (const [key, id] of pending) {
              const mission = states.find(s => Number(s.mission_id) === id)
              const target = Number(mission?.mission?.threshold ?? mission?.threshold ?? ({ read: 3, like: 5, share: 1 })[key])
              const count = Math.max(0, Math.min(20, target - Number(mission.happened_times || 0)))
              for (const item of (posts.posts || []).slice(0, count)) await run("mission", key, `${{ read: "阅读", like: "点赞", share: "分享" }[key]} ${item.post.post_id}`, async () => {
                const postId = String(item.post.post_id), gids = String(forumId)
                const request = key === "read" ? { url: "/post/api/getPostFull", params: { post_id: postId } } : key === "share" ? { url: "/apihub/api/getShareConf", params: { entity_id: postId, entity_type: 1 }, web: true } : { url: "/apihub/sapi/upvotePost", method: "POST", body: { post_id: postId, is_cancel: false, gids } }
                this.client.assert(await sendRequest(`${BBS.origin}${request.url}`, profile, { ...request, stoken: key !== "share", onCaptchaEvent: options.onCaptchaEvent }))
                if (key === "like" && enabled.cancel_like) {
                  await this.sleep()
                  this.client.assert(await sendRequest(`${BBS.origin}/apihub/sapi/upvotePost`, profile, { method: "POST", body: { post_id: postId, is_cancel: true, gids }, stoken: true }))
                }
                await this.sleep(); return { message: "请求成功，任务与米游币以回读为准" }
              })
            }
          }
          const reread = await run("missions", "after", "社区任务回读", async () => ({ data: await this.client.missions(profile, requestOptions) }))
          after = reread.data
        } else if (!(profile.device?.id && profile.device?.fp)) tasks.push({ kind: "community", key: "device", label: "社区任务", status: "skipped", message: "需要配对的设备 ID 与已签发 FP" })
      }
      for (const row of tasks.filter(row => row.kind === "mission" && row.status === "success")) {
        const id = { read: 59, like: 60, share: 61 }[row.key]
        const mission = after?.states?.find(s => Number(s.mission_id) === id)
        if (!mission?.is_get_award) { row.status = "unverified"; row.message = "请求已完成，回读尚未确认任务奖励" }
      }
      const balance = Number(after?.total_points), received = Number(after?.already_received_points), initial = Number(before?.already_received_points)
      const coins = after && [balance, received, initial].every(Number.isFinite) ? { balance, received, gained: Math.max(0, received - initial) } : null
      const rows = tasks.map(({ roles, posts, data, ...row }) => row)
      const ok = !rows.some(row => ["failed", "unverified"].includes(row.status))
      const message = [...rows.map(row => `${row.label}：${row.message || row.status}`), ...(coins ? [`米游币：本次增加 ${coins.gained}，今日已领 ${coins.received}，余额 ${coins.balance}`] : [])].join("\n")
      options.signal?.throwIfAborted()
      return { ok, tasks: rows, events, coins, message }
    })
  }
}
