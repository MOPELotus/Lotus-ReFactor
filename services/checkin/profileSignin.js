import { refreshAccountAndSync } from "../../core/login/refresh.js"
import { loadProfile } from "../../core/config/profile.js"
import { AccountService } from "../../core/login/account.js"
import { renderTemplate } from "../../core/render/service.js"
import { MiyousheTasks } from "../miyoushe/tasks.js"
import { appendCheckinAudit } from "./audit.js"
import { createProfileRequestGuard } from "../../core/login/requestGuard.js"

export class ProfileSigninService {
  constructor(options = {}) {
    this.account = options.account || new AccountService(options)
    this.runner = options.runner || new MiyousheTasks(options)
    this.render = options.render !== false
    this.beforeRequest = options.beforeRequest
  }

  async run({ qq, profileId = 1, profile, refresh = true, onCaptchaEvent, beforeRequest = this.beforeRequest } = {}) {
    const userId = String(qq || profile?.user?.qq || "")
    const id = Number(profileId || profile?.profile?.id || 1)
    let activeProfile = profile || await loadProfile(userId, id)

    if (refresh) {
      try {
        activeProfile = await refreshAccountAndSync(userId, id, { accountService: this.account, expectedProfile: activeProfile })
      } catch (error) {
        return this.failure({
          stage: "refresh",
          profile: activeProfile,
          error,
          message: "签到前刷新登录信息失败，本次签到已停止。",
          advice: "请重新扫码登录对应 profile，或检查 stoken 是否已失效。",
        })
      }
    }

    if (!activeProfile.account?.cookie) {
      return this.failure({
        stage: "precheck",
        profile: activeProfile,
        error: new Error("profile has no cookie"),
        message: "profile 尚未保存 cookie，无法执行签到。",
        advice: "请先使用 #扫码登录 绑定当前 profile。",
      })
    }

    const skipped = collectSkipped(activeProfile)
    try {
      const guard = beforeRequest || createProfileRequestGuard(activeProfile, {
        qq: userId, profileId: id,
        ...(typeof this.account.get === "function" ? { loadProfile: (user, slot) => this.account.get(user, slot) } : {}),
      })
      const result = await this.runner.runProfile(prepareRunnableProfile(activeProfile), {
        onCaptchaEvent,
        beforeRequest: guard,
      })
      const image = this.render
        ? await renderSigninResult({ result, profile: activeProfile, skipped })
        : null
      const outcome = {
        ok: Boolean(result.ok),
        stage: "checkin",
        profile: activeProfile,
        result,
        skipped,
        image,
        message: result.message || (result.ok ? "签到完成。" : "签到失败。"),
      }
      await this.audit(outcome)
      return outcome
    } catch (error) {
      return this.failure({
        stage: "runner",
        profile: activeProfile,
        error,
        message: "米游社任务执行失败。",
        advice: "请确认 profile 登录态、设备信息及验证码模型。",
      })
    }
  }

  async failure({ stage, profile, error, message, advice }) {
    const image = this.render
      ? await renderSigninFailure({
        stage,
        profile,
        error,
        message,
        advice,
      })
      : null
    const outcome = {
      ok: false,
      stage,
      profile,
      error,
      image,
      message: error.message || message,
    }
    await this.audit(outcome)
    return outcome
  }

  async audit(outcome) {
    try {
      await appendCheckinAudit(outcome)
    } catch (error) {
      logger?.warn?.(`[Lotus-Plugin] checkin audit failed: ${error.message}`)
    }
  }
}

export async function renderSigninResult({ result, profile, skipped }) {
  const detail = String(result.message || "")
  const message = result.ok
    ? detail.split(/\r\n?|\n/).map(line => line.trim()).filter(line => line.includes("米游币")).join("\n")
    : (detail || "无详细结果").slice(0, 180)

  return renderTemplate("checkin-result", {
    title: profile.user?.nickname || `QQ ${profile.user?.qq || ""}`,
    subtitle: `profile ${profile.profile?.id || 1}`,
    badge: result.ok ? "米游币" : "失败",
    message,
    avatar: qqAvatar(profile.user?.qq),
    userId: profile.user?.qq,
    games: buildSigninRows(profile, result, skipped),
  }, {
    saveId: `lotus-checkin-${profile.user?.qq || "user"}-${profile.profile?.id || 1}`,
  })
}

export async function renderSigninFailure({ stage, profile, error, message, advice }) {
  const userId = profile?.user?.qq || ""
  const profileId = profile?.profile?.id || 1
  return renderTemplate("checkin-result", {
    title: profile?.user?.nickname || `QQ ${userId}`,
    subtitle: `profile ${profileId}`,
    badge: "失败",
    message: `${message} ${error?.message || ""} ${advice || ""}`.trim(),
    avatar: qqAvatar(userId),
    userId,
    games: buildSigninRows(profile || {}, { ok: false }, collectSkipped(profile || {})),
  }, {
    saveId: `lotus-checkin-error-${userId || "user"}-${profileId}`,
  })
}

export function prepareRunnableProfile(profile) {
  const copy = structuredClone(profile)
  if (copy.mihoyobbs?.enable && !(copy.device?.id && copy.device?.fp)) {
    copy.mihoyobbs.enable = false
  }
  return copy
}

export function collectSkipped(profile) {
  const skipped = []
  if (profile.mihoyobbs?.enable && !(profile.device?.id && profile.device?.fp)) {
    skipped.push("社区任务需要配对的设备 ID 和 FP，本次仅跳过社区任务；自动设备会继续补全 FP，也可绑定真机。")
  }
  return skipped
}

const SIGNIN_GAMES = [
  { key: "genshin", label: "原神", forumId: 2 },
  { key: "honkai2", label: "崩坏2", forumId: 3 },
  { key: "honkai3rd", label: "崩坏3", forumId: 1 },
  { key: "tears_of_themis", label: "未定事件簿", forumId: 4 },
  { key: "villa", label: "大别野", forumId: 5, communityOnly: true },
  { key: "honkai_sr", label: "星铁", forumId: 6 },
  { key: "zzz", label: "绝区零", forumId: 8 },
  { key: "hna", label: "因缘精灵", forumId: 9 },
  { key: "starry", label: "星布谷地", forumId: 10, communityOnly: true },
]

function buildSigninRows(profile, result, skipped = []) {
  const games = profile.games?.cn || {}
  const status = (kind, key) => {
    const rows = (result.tasks || []).filter(row => row.kind === kind && row.key === key)
    if (!rows.length) return "未执行"
    if (rows.some(row => row.status === "failed")) return "失败"
    if (rows.every(row => row.status === "skipped")) return "跳过"
    return rows.every(row => row.status === "already") ? "已完成" : "成功"
  }
  const bbs = profile.mihoyobbs || {}
  const communityEnabled = Boolean(bbs.enable && (bbs.tasks?.checkin ?? bbs.checkin ?? true))
  const missingDevice = skipped.some(text => String(text).includes("设备"))
  return SIGNIN_GAMES.map(game => {
    const gameEnabled = !game.communityOnly && games.enable !== false && games[game.key]?.checkin === true
    const forumEnabled = communityEnabled && bbs.checkin_list?.map?.(Number).includes(game.forumId)
    return {
      label: game.label,
      game: game.communityOnly ? "无" : gameEnabled ? status("game", game.key) : "关闭",
      community: forumEnabled ? (missingDevice ? "跳过" : status("community", String(game.forumId))) : "关闭",
    }
  })
}

function qqAvatar(qq) {
  const id = String(qq || "1102305070")
  return `https://q1.qlogo.cn/g?b=qq&nk=${id}&s=640`
}
