import { requestCaptchaChallenge, verifyCaptchaChallenge, captchaVerificationResult } from "../../core/captcha/mysHandler.js"
import { MIHOYO_PROTOCOL } from "../../core/mihoyo/constants.js"
import { captchaContextHeaders } from "../../core/captcha/requestContext.js"
import { getDs2 } from "../../core/mihoyo/ds.js"
import { captchaVersion } from "../../core/captcha/result.js"

const GAMES = {
  gs: { id: "2", appKey: "" },
  sr: { id: "6", appKey: "hkrpg_game_record" },
  zzz: { id: "8", appKey: "game_record_zzz" },
}

export function requiresMiyousheCaptcha(result) {
  const retcode = Number(result?.retcode)
  if (retcode === 10041) return false
  if ([1034, 10035].includes(retcode)) return true
  // Inline sign challenges use successful envelopes with risk flags. Other
  // failures may carry stale challenge data; preserve their original error.
  if (result?.retcode == null || result.retcode === "" || retcode !== 0) return false
  return [result?.data, inlineCaptchaData(result)].some(data => {
    const risk = data?.is_risk
    return risk === true || (typeof risk === "number" && risk > 0) || Number(data?.success) === 1
  })
}

export function captchaRoute(target, result, options = {}) {
  if (Number(result?.retcode) === 10041) throw accountRiskError()
  requireV3BusinessChallenge(result.data)
  const inline = inlineCaptchaData(result)
  requireV3BusinessChallenge(inline)
  if (inline?.gt && inline?.challenge) return { kind: "inline" }
  const bbsHost = /^bbs-api(?:-os)?\.(?:miyoushe\.com|mihoyo\.com|hoyolab\.com)$/.test(target.hostname)
  const recordPath = /^\/(?:game_record\/|event\/game_record_zzz\/api\/)/.test(target.pathname)
  // HoYoLAB serves legacy game records and community APIs on the same host.
  // Select the business protocol by its path before falling back to BBS misc.
  if (bbsHost && !recordPath) {
    return { kind: "bbs", origin: target.origin, overseas: target.hostname.endsWith("hoyolab.com") }
  }
  const allowedHost = /^(?:api-takumi(?:-record)?\.mihoyo\.com|act-nap-api\.mihoyo\.com|sg-public-api\.hoyolab\.com|sg-act-nap-api\.hoyolab\.com)$/
  if (!bbsHost && !allowedHost.test(target.hostname)) throw new Error("该业务的验证码验证接口尚未核实")
  // Record app keys belong to the record frontend. Sign-in returns its own
  // inline challenge and retries /sign with x-rpc-* Geetest headers instead.
  if (!recordPath) {
    throw new Error("该业务未返回内嵌验证码，验证接口尚未核实")
  }
  const game = resolveGame(target, options)
  const tool = Number(result.retcode) === 10035
  if (tool && !["sr", "zzz"].includes(game)) {
    throw new Error("该游戏的 toolcomsrv 验证 app_key 尚未核实")
  }
  if (!GAMES[game]) {
    throw new Error("该业务未返回内嵌验证码，验证接口尚未核实")
  }
  return { kind: tool ? "tool" : "record", game, ...GAMES[game], overseas: target.hostname.endsWith("hoyolab.com") }
}

function resolveGame(target, { game, headers = {}, params = {}, body = {} } = {}) {
  const value = String(game || params.game_biz || body?.game_biz || target.searchParams.get("game_biz") || "").toLowerCase()
  if (/^(?:gs|genshin|hk4e)(?:_cn|_global)?$/.test(value)) return "gs"
  if (/^(?:sr|honkai_sr|hkrpg)(?:_cn|_global)?$/.test(value)) return "sr"
  if (/^(?:zzz|nap)(?:_cn|_global)?$/.test(value)) return "zzz"
  if (/(?:genshin|hk4e)/.test(target.pathname)) return "gs"
  if (/(?:hkrpg|starrail)/.test(target.pathname)) return "sr"
  if (/(?:zzz|nap)/.test(target.pathname)) return "zzz"
  const header = Object.entries(headers).find(([key]) => key.toLowerCase() === "x-rpc-challenge_game")?.[1]
  return Object.keys(GAMES).find(key => GAMES[key].id === String(header))
}

export function gameCaptchaContext(route, profile, headersFor, requestContext) {
  const server = route.overseas ? "os_usa" : "cn_gf01"
  const device = profile.device || {}
  return {
    retcode: route.kind === "tool" ? 10035 : 1034,
    game: route.game,
    appKey: route.appKey,
    server,
    isCn: !route.overseas,
    cookie: profile.account?.cookie || "",
    extraHeaders: {
      ...captchaContextHeaders(requestContext),
      ...(route.id ? { "x-rpc-challenge_game": route.id } : {}),
      ...(device.id ? { "x-rpc-device_id": device.id } : {}),
      ...(device.fp ? { "x-rpc-device_fp": device.fp } : {}),
    },
    // The record and tool APIs use DS2 over the exact query and JSON body.
    mysApi: { server, getHeaders(query, body) {
      return {
        ...headersFor(profile, { web: true, overseas: route.overseas }),
        DS: getDs2(query, body, route.overseas ? MIHOYO_PROTOCOL.hoyolab.salt : MIHOYO_PROTOCOL.bbsCn.x4Salt),
      }
    } },
  }
}

export function requireCaptchaChallenge(result) {
  if (result?.retcode !== 0) throw captchaApiError(result, "创建验证码")
  return requireInlineCaptchaChallenge(result)
}

export function requireInlineCaptchaChallenge(result) {
  if (Number(result?.retcode) === 10041) throw accountRiskError()
  if (![0, 1034, 10035].includes(Number(result?.retcode))) throw captchaApiError(result, "业务验证码")
  requireV3BusinessChallenge(result?.data)
  const data = inlineCaptchaData(result)
  requireV3BusinessChallenge(data)
  if (!data?.gt || !data?.challenge) throw new Error("业务未返回受支持的 v3 challenge")
  return data
}

function inlineCaptchaData(result) {
  // HoYoLAB Genshin sign nests its v3 risk payload; SR/ZZZ return it directly.
  const nested = result?.data?.gt_result
  return nested && typeof nested === "object" && !Array.isArray(nested) ? nested : result?.data
}

function accountRiskError() {
  const error = new Error("当前账号存在风险（10041），请在官方客户端处理后重试")
  error.retcode = 10041
  return error
}

function requireV3BusinessChallenge(data) {
  if (captchaVersion(data) === 4) throw new Error("该业务的 Geetest v4 校验协议尚未核实，已停止识别")
}

export const captchaVerification = captchaVerificationResult

function captchaApiError(result, action) {
  const error = new Error(`${action}失败（${result?.retcode ?? "无状态码"}）：${String(result?.message || result?.msg || "未提供原因").slice(0, 120)}`)
  error.retcode = result?.retcode
  return error
}

export { requestCaptchaChallenge, verifyCaptchaChallenge }
