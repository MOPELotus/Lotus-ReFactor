import { solveMysRequestCaptcha } from "../../core/captcha/mysHandler.js"
import { captchaRoute, requiresMiyousheCaptcha } from "../miyoushe/captcha.js"

// Lotus-owned direct MysApi calls do not pass through MysInfo's error hook.
export async function requestGenshinMysApi({ mysApi, type, data = {}, e, profileContext, requestMetadata, fetchImpl, solveCaptchaImpl, onCaptchaEvent } = {}) {
  const res = await mysApi.getData(type, data)
  if (!requiresMiyousheCaptcha(res)) return res
  const metadata = requestMetadata || res?.requestMetadata
  const request = await mysApi.getUrl(type, { ...data, headers: { ...(data.headers || {}) } })
  const target = new URL(request?.url)
  const route = captchaRoute(target, res, { game: e?.game || mysApi.game, headers: data.headers })
  if (!["record", "tool"].includes(route.kind)) throw new Error("该 MysApi 业务的验证码验证接口尚未核实")
  return solveMysRequestCaptcha({
    e,
    args: { mysApi, type, data, res, requestMetadata: metadata, profileContext },
    fetchImpl,
    solveCaptchaImpl,
    onCaptchaEvent,
  })
}
