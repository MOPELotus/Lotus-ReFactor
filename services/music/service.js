import path from "node:path"
import QRCode from "qrcode"
import { setTimeout as sleep } from "node:timers/promises"
import { TuneWeaveService } from "../tuneweave/service.js"
import { resolveQrProfile } from "../tuneweave/auth.js"
import { NeteasePartnerService } from "../neteasePartner/service.js"
import { downloadRanges } from "../media/range-download.js"
import { resolveCommandPath } from "../bilibili/service.js"
import { createMediaTask, releaseMediaTask } from "../media/tasks.js"
import { runMediaProcess } from "../media/files.js"
import { resolveData } from "../../core/path.js"
import { readMusicAccounts, saveMusicAccount } from "./accounts.js"

export const MUSIC_PLATFORMS = Object.freeze({ netease: "网易云", qq: "QQ音乐", kugou: "酷狗", kuwo: "酷我", migu: "咪咕", soda: "汽水" })
export const MUSIC_QR_TYPES = Object.freeze({ qq: [{ name: "QQ", type: "qq" }, { name: "QQ音乐", type: "mobile" }, { name: "微信", type: "wechat" }], kugou: [{ name: "酷狗音乐", type: "standard" }, { name: "酷狗概念版", type: "concept" }, { name: "网页版", type: "web" }] })
export const musicSessionKey = e => `${e.self_id || ""}:${e.group_id || "private"}:${e.user_id}`
export class MusicService {
  constructor(options = {}) {
    this.tuneweave = options.tuneweave || new TuneWeaveService({ config: options.tuneweaveConfig })
    this.config = { quality: "standard", search_limit: 10, download_timeout_ms: 180000, max_size_mb: 128, ...options.config }
    this.toolsPath = options.toolsPath || "data/tools/bin"
    this.tasksDir = options.tasksDir || resolveData("music", "tasks")
    this.fetch = options.fetch || globalThis.fetch
  }
  async request(route, options = {}) {
    const accounts = await readMusicAccounts()
    return this.tuneweave.request(route, { ...options, credentials: Object.values(accounts).map(a => a.credential).filter(Boolean),
      onCredentialUpdates: updates => Promise.all(updates.filter(u => accounts[u.platform]?.credential).map(u =>
        saveMusicAccount(u.platform, { credential: u.credential }, { expected: accounts[u.platform] }))) })
  }
  async adoptPartnerAccount() {
    if ((await readMusicAccounts()).netease) return
    const linked = (await new NeteasePartnerService({ tuneweave: this.tuneweave }).loadAccounts()).filter(a => a.tuneweave_account)
    if (linked.length === 1) await saveMusicAccount("netease", { alias: linked[0].tuneweave_account, uid: linked[0].uid, nickname: linked[0].nickname, credential: "" }, { expected: null })
  }
  async platforms() {
    const items = await this.tuneweave.request("/v1/capabilities")
    return Object.entries(MUSIC_PLATFORMS).map(([platform, name]) => ({ platform, name, capabilities: items.find(i => i.platform === platform && i.registered)?.capabilities || [] })).filter(i => i.capabilities.length)
  }
  async search(platform, keyword, page = 1) {
    if (!(platform in MUSIC_PLATFORMS) || !keyword.trim()) throw new Error("请选择有效平台并输入歌曲关键词")
    const limit = this.config.search_limit
    const account = (await readMusicAccounts())[platform]
    // Use the saved identity for search as well as playback, without mixing
    // results from other platforms or losing rotated caller credentials.
    const items = await this.request(`/v1/search?${new URLSearchParams({ platform, type: "track", q: keyword.trim(), limit: String(limit), offset: String((page - 1) * limit), ...(account?.alias && !account.credential ? { account: account.alias } : {}) })}`)
    return items.filter(i => i.type === "track").map(i => i.data)
  }
  async resolve(track) {
    const accounts = await readMusicAccounts(), account = accounts[track.platform]
    const params = new URLSearchParams({ quality: this.config.quality, fallback: "true", unblock: "true", fallback_platforms: Object.keys(MUSIC_PLATFORMS).filter(p => p !== track.platform).join(","), ...(account?.alias && !account.credential ? { account: account.alias } : {}) })
    const stream = await this.request(`/v1/tracks/${encodeURIComponent(track.ref)}/stream?${params}`)
    if (!stream?.url || stream.trial) throw new Error("没有可用的完整音源，建议主人扫码登录音乐平台")
    return stream
  }
  async prepare(track) {
    const stream = await this.resolve(track), task = await createMediaTask(this.tasksDir)
    try {
      const file = path.join(task.dir, "source.audio"), voice = path.join(task.dir, "voice.wav")
      const url = new URL(stream.url, this.tuneweave.config.api_url).href
      // Credentials on local content endpoints must never follow a CDN redirect.
      const fetchMedia = async (target, options) => {
        let current = new URL(target), headers = { ...options.headers }
        for (let i = 0; i < 6; i++) {
          const response = await this.fetch(current, { ...options, headers, redirect: "manual" })
          if (![301, 302, 303, 307, 308].includes(response.status)) return response
          const next = new URL(response.headers.get("location"), current);await response.body?.cancel()
          if (next.origin !== current.origin) headers = Object.fromEntries(Object.entries(headers).filter(([key]) => !/^(cookie|authorization|x-tuneweave-credential)$/i.test(key)))
          current = next
        }
        throw new Error("音频地址重定向过多")
      }
      await downloadRanges([url, ...(stream.backup_urls || []).map(u => new URL(u, this.tuneweave.config.api_url).href)], file, { fetch: fetchMedia, headers: stream.headers || {}, concurrency: 4, timeoutMs: this.config.download_timeout_ms, maxBytes: this.config.max_size_mb * 1024 * 1024 })
      const ffmpeg = await resolveCommandPath("ffmpeg", this.toolsPath), ffprobe = await resolveCommandPath("ffprobe", this.toolsPath)
      if (!ffmpeg || !ffprobe) throw new Error("请先初始化 FFmpeg 工具环境")
      const info = JSON.parse((await runMediaProcess(ffprobe, ["-v", "error", "-show_entries", "format=duration:stream=codec_type", "-of", "json", file], { timeoutMs: 30000 })).output)
      const duration = Number(info.format?.duration)
      if (!info.streams?.some(s => s.codec_type === "audio") || !Number.isFinite(duration) || duration <= 0) throw new Error("下载结果不是有效音频")
      if (stream.duration_ms && duration * 1000 < stream.duration_ms - Math.max(3000, stream.duration_ms * 0.02)) throw new Error("音频时长不足，未按完整歌曲发送")
      await runMediaProcess(ffmpeg, ["-nostdin", "-y", "-i", file, "-vn", "-ac", "1", "-ar", "24000", "-c:a", "pcm_s16le", voice], { cwd: task.dir, timeoutMs: this.config.download_timeout_ms })
      return { taskDir: task.dir, taskId: task.id, voiceFile: voice, duration, stream, track }
    } catch (error) { await releaseMediaTask(this.tasksDir, task.dir);throw error }
  }
  async cleanup(result) { await releaseMediaTask(this.tasksDir, result.taskDir) }
  async createLogin(platform, owner, loginType) {
    if (platform === "netease") {
      const service = new NeteasePartnerService({ tuneweave: this.tuneweave })
      const qr = await service.createQrLogin(owner)
      return { platform, key: qr.key, alias: qr.alias, image: qr.qrimg, owner }
    }
    if (!(platform in MUSIC_PLATFORMS)) throw new Error("不支持的音乐平台")
    const alias = `lotus-music-${platform}`
    const qr = await this.tuneweave.request("/v1/auth/qr", { method: "POST", body: { platform, account: alias, credential_mode: "both", ...(loginType ? { login_type: loginType } : {}) } })
    if (!qr.transaction_id || !qr.url && !qr.image_data_url) throw new Error("平台没有返回可用二维码")
    return { platform, key: qr.transaction_id, alias, image: qr.image_data_url || await QRCode.toDataURL(qr.url), owner }
  }
  async waitLogin(login, { signal } = {}) {
    if (login.platform === "netease") return new NeteasePartnerService({ tuneweave: this.tuneweave }).waitQrLogin({ key: login.key, alias: login.alias, qq: login.owner, signal })
    const deadline = Date.now() + 180000
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new Error("扫码登录已取消")
      const result = await this.tuneweave.request(`/v1/auth/qr/${encodeURIComponent(login.key)}`)
      if (signal?.aborted) throw new Error("扫码登录已取消")
      if (result.state === "confirmed") {
        const profile = await resolveQrProfile(this.tuneweave, { platform: login.platform, alias: login.alias, profile: result.profile, signal })
        await saveMusicAccount(login.platform, { alias: login.alias, uid: profile.user_id, nickname: profile.nickname || "", credential: result.caller_credential?.value || "" })
        return { ok: true }
      }
      if (["expired", "failed", "verification_required"].includes(result.state)) throw new Error("二维码已过期或需要附加验证，请重新登录")
      await sleep(3000, undefined, { signal })
    }
    throw new Error("扫码登录超时")
  }
}
export function musicShare(track, stream) {
  // NapCat passes this platform directly to its signer. type=custom is signed
  // as QQ Music even with subtype=163, so keep the selected track's identity.
  const type = { netease: "163", qq: "qq", kugou: "kugou", kuwo: "kuwo", migu: "migu" }[track.platform]
  if (!type) return null
  const artists = track.artists?.map(a => a.name).join(" / ") || "未知歌手", id = encodeURIComponent(track.id)
  const links = { netease: `https://music.163.com/#/song?id=${id}`, qq: `https://y.qq.com/n/ryqq/songDetail/${id}` }
  const url = links[track.platform] || track.extensions?.url
  if (!url) return null
  const cover = track.album?.cover_url || track.artists?.[0]?.avatar_url || ""
  if (!cover) return null
  const headerKeys = Object.keys(stream.headers || {})
  if (headerKeys.some(k => /credential|authorization|cookie/i.test(k)) || /^https?:\/\/(?:127\.|localhost|\[::1\])/.test(stream.url)) return null
  return { type: "music", data: { type, url, audio: stream.url, title: track.name, content: artists, singer: artists, image: cover } }
}
