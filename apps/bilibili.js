const BasePlugin = globalThis.plugin

import fs from "node:fs/promises"
import path from "node:path"
import { LOTUS_INTERCEPT_PRIORITY } from "../core/intercept/priority.js"
import { loadGlobalConfig } from "../core/config/global.js"
import { PermissionService } from "../core/permissions/service.js"
import { renderStatusCard, renderTemplate } from "../core/render/service.js"
import { replyImage, replyText } from "../core/transport/reply.js"
import {
  BilibiliService,
  formatNumber,
  normalizeDownloadConfig,
} from "../services/bilibili/service.js"
import { ToolInstallerService } from "../services/tools/installer.js"

const searchCache = new Map()

export class LotusBilibili extends BasePlugin {
  constructor() {
    super({
      name: "[Lotus-Plugin] Bilibili",
      dsc: "Lotus Bilibili parser",
      event: "message",
      priority: LOTUS_INTERCEPT_PRIORITY,
      rule: [
        { reg: "^#荷花搜视频.+", fnc: "searchVideo" },
        { reg: "^#看[0-9]+$", fnc: "pickVideo" },
        { reg: "^#荷花看视频.+", fnc: "directWatch" },
        { reg: "^#(B站|b站|荷花)(下载|下视频)\\s+[\\s\\S]+$", fnc: "downloadVideo" },
        { reg: "^#B站登录$", fnc: "login" },
        { reg: "^#BBDown登录$", fnc: "bbdownLogin" },
        { reg: "(bilibili.com|b23.tv|bili2233.cn|live.bilibili.com|^[Bb][Vv][1-9A-Za-z]{10}$|^[Aa][Vv][0-9]+$)", fnc: "parse" },
      ],
    })
  }

  async parse() {
    const service = await createService()
    const target = service.extractTarget(buildBilibiliMessageText(this.e))
    if (!target) return false
    return this.renderInfo(await service.getInfo(target), { target, service })
  }

  async searchVideo() {
    const keyword = String(this.e.msg || "").replace(/^#荷花搜视频/, "").trim()
    if (!keyword) {
      await replyText(this, "[荷花插件]请输入搜索关键词。")
      return true
    }
    try {
      const results = await (await createService()).search(keyword)
      searchCache.set(cacheKey(this.e), {
        expires: Date.now() + 120000,
        results,
      })
      const image = await renderStatusCard({
        title: "B站搜索",
        subtitle: keyword,
        badge: String(results.length),
        message: results.length ? "两分钟内发送 #看1 这类序号继续解析。" : "没有搜索到相关视频。",
        userId: this.e.user_id,
        items: results.map((item, index) => ({
          label: `#看${index + 1}`,
          value: `${item.title} · ${item.author || "未知"} · ${formatNumber(item.play)}`,
        })),
      }, {
        saveId: `lotus-bili-search-${this.e.user_id || "user"}`,
      })
      await replyImage(this, image, "[荷花插件]B站搜索完成。")
    } catch (error) {
      await this.renderError("B站搜索", error)
    }
    return true
  }

  async pickVideo() {
    const cached = searchCache.get(cacheKey(this.e))
    if (!cached || cached.expires < Date.now()) return false
    const index = Number(String(this.e.msg || "").replace(/^#看/, ""))
    const item = cached.results[index - 1]
    if (!item) {
      await replyText(this, `[荷花插件]请输入 1-${cached.results.length} 之间的序号。`)
      return true
    }
    const service = await createService()
    return this.renderInfo(await service.getInfo(item.url), { target: item.url, service })
  }

  async directWatch() {
    const keyword = String(this.e.msg || "").replace(/^#荷花看视频/, "").trim()
    if (!keyword) {
      await replyText(this, "[荷花插件]请输入关键词。")
      return true
    }
    try {
      const [first] = await (await createService()).search(keyword, { limit: 1 })
      if (!first) throw new Error("未搜索到相关视频")
      const service = await createService()
      return this.renderInfo(await service.getInfo(first.url), { target: first.url, service })
    } catch (error) {
      await this.renderError("B站直看", error)
      return true
    }
  }

  async login() {
    const globalConfig = await loadGlobalConfig()
    const permission = new PermissionService({ permissions: globalConfig.permissions })
      .explain(this.e, "bilibili.login")
    if (!permission.ok) {
      await this.renderError("B站登录", new Error("只有 bot 主人可以登录 B站账号。"))
      return true
    }

    const service = await createService()
    try {
      const qr = await service.createQrLogin()
      const image = await renderTemplate("qr-login", {
        title: "B站登录",
        subtitle: "荷花插件 Bilibili",
        badge: "3 MIN",
        notice: "使用 Bilibili App 扫码确认。登录 cookie 会保存在 data/bilibili/account.yaml，不写入仓库。",
        qrDataUrl: qr.qrDataUrl,
        profileId: "bilibili",
      }, {
        saveId: `lotus-bili-login-${this.e.user_id || "master"}`,
      })
      await replyImage(this, image, "[荷花插件]B站登录二维码已生成。")
      const result = await service.waitQrLogin({
        qrcodeKey: qr.qrcodeKey,
      })
      const report = await renderStatusCard({
        title: "B站登录",
        subtitle: "荷花插件 Bilibili",
        badge: "完成",
        message: "B站账号 cookie 已保存，后续搜索和解析会自动使用。",
        userId: this.e.user_id,
        items: [
          { label: "来源", value: result.account.source },
          { label: "保存时间", value: result.account.saved_at },
        ],
      }, {
        saveId: `lotus-bili-login-ok-${this.e.user_id || "master"}`,
      })
      await replyImage(this, report, "[荷花插件]B站登录完成。")
    } catch (error) {
      await this.renderError("B站登录", error)
    }
    return true
  }

  async bbdownLogin() {
    const globalConfig = await loadGlobalConfig()
    const permission = new PermissionService({ permissions: globalConfig.permissions })
      .explain(this.e, "bilibili.login")
    if (!permission.ok) {
      await this.renderError("BBDown登录", new Error("只有 bot 主人可以维护 BBDown 登录态。"))
      return true
    }

    const service = await createService()
    try {
      const result = await service.runBBDownLogin(globalConfig.bilibili?.download || {}, {
        onEvent: async event => {
          if (event.qrPath) {
            const qrDataUrl = await imageFileToDataUrl(event.qrPath)
            const image = await renderTemplate("qr-login", {
              title: "BBDown 登录",
              subtitle: "荷花插件 Bilibili",
              badge: "扫码",
              notice: "使用 Bilibili App 扫码确认。该登录态供 BBDown 下载会员/高画质内容使用。",
              qrDataUrl,
              profileId: "bbdown",
            }, {
              saveId: `lotus-bbdown-login-${this.e.user_id || "master"}`,
            })
            await replyImage(this, image, "[荷花插件]BBDown 登录二维码已生成。")
          } else if (event.message) {
            await replyText(this, `[荷花插件]${event.message}`)
          }
        },
      })
      const image = await renderStatusCard({
        title: "BBDown 登录",
        subtitle: "荷花插件 Bilibili",
        badge: result.ok ? "完成" : "结束",
        message: result.ok ? "BBDown 登录流程已完成。" : "BBDown 登录进程已结束，请查看日志判断是否成功。",
        userId: this.e.user_id,
        items: [
          { label: "退出码", value: String(result.code ?? "-") },
          { label: "日志", value: result.logPath || "无" },
        ],
      }, {
        saveId: `lotus-bbdown-login-result-${this.e.user_id || "master"}`,
      })
      await replyImage(this, image, "[荷花插件]BBDown 登录流程结束。")
    } catch (error) {
      await this.renderError("BBDown登录", error)
    }
    return true
  }

  async downloadVideo() {
    const target = String(this.e.msg || "").replace(/^#(?:B站|b站|荷花)(?:下载|下视频)\s*/i, "").trim()
    if (!target) {
      await replyText(this, "[荷花插件]请输入要下载的 B站链接、BV号或 av号。")
      return true
    }

    return this.runBiliDownload(target, { service: await createService() })
  }

  async renderInfo(info, options = {}) {
    const image = await renderTemplate("bilibili-info", {
      type: info.type,
      id: info.type === "live" ? `直播间 ${info.roomId}` : info.bvid,
      title: info.title,
      owner: info.owner,
      cover: info.cover,
      duration: info.duration,
      desc: info.desc,
      liveStatus: info.liveStatus,
      online: info.online,
      stat: info.stat || {},
      userId: this.e.user_id,
    }, {
      saveId: `lotus-bili-${this.e.user_id || "user"}`,
    })
    await replyImage(this, image, "[荷花插件]B站解析完成。")
    if (info.type === "live" && info.playerUrl) {
      await replyText(this, `[荷花插件]独立播放器：${info.playerUrl}`)
    } else if (info.type === "video" && info.url && options.download !== false) {
      await this.runBiliDownload(options.target || info.url, {
        service: options.service,
        title: "B站解析下载",
        announce: false,
      })
    }
    return true
  }

  async runBiliDownload(target, options = {}) {
    const globalConfig = await loadGlobalConfig()
    const permission = new PermissionService({ permissions: globalConfig.permissions })
      .explain(this.e, "bilibili.download")
    if (!permission.ok) {
      await this.renderError(options.title || "B站下载", new Error("你没有使用 B站下载的权限。"))
      return true
    }

    const downloadConfig = normalizeDownloadConfig({
      ...(globalConfig.bilibili || {}),
      ...(globalConfig.bilibili?.download || {}),
    })
    if (!downloadConfig.enable) {
      await this.renderError(options.title || "B站下载", new Error("B站下载未启用，请由 bot 主人在 global.yaml 中开启 bilibili.download.enable。"))
      return true
    }

    const service = options.service || await createService()
    try {
      const installPermission = new PermissionService({ permissions: globalConfig.permissions })
        .explain(this.e, "tools.install")
      if (globalConfig.tools?.auto_install !== false && installPermission.ok) {
        await replyText(this, "[荷花插件]正在检查 BBDown/ffmpeg/aria2 工具链，缺失时会自动安装。")
        const tools = await new ToolInstallerService({ config: globalConfig.tools }).ensureAll()
        if (!tools.ok) {
          throw new Error(`工具链初始化失败：${tools.items?.filter(item => !item.ok).map(item => `${item.name}:${item.reason}`).join(" / ") || "unknown"}`)
        }
      }
      if (options.announce !== false) await replyText(this, "[荷花插件]开始处理 B站下载任务。")
      const result = await service.download(target, {
        ...(globalConfig.bilibili || {}),
        ...(globalConfig.bilibili?.download || {}),
      }, {
        onEvent: async event => {
          if (event.message) await replyText(this, `[荷花插件]${event.message}`)
        },
      })
      if (!result.ok) {
        if (result.reason === "live_download_unsupported" && result.info) {
          await replyText(this, "[荷花插件]直播内容不进入下载流程，已改为发送直播信息和独立播放器链接。")
          return this.renderInfo(result.info, { download: false })
        }
        await this.renderError(options.title || "B站下载", new Error(downloadFailureMessage(result)))
        return true
      }

      for (const file of result.files || []) {
        await sendBiliFile(this.e, file, downloadConfig)
      }

      const image = await renderStatusCard({
        title: options.title || "B站下载",
        subtitle: result.info?.bvid || "荷花插件 Bilibili",
        badge: result.fromCache ? "缓存" : "完成",
        message: `已生成 ${result.files?.length || 0} 个文件并尝试发送。`,
        userId: this.e.user_id,
        items: [
          { label: "标题", value: result.info?.title || "-" },
          { label: "方式", value: result.downloader || "-" },
          { label: "多P策略", value: result.policy || "-" },
          { label: "文件", value: (result.files || []).map(file => path.basename(file)).join(" / ") || "无" },
        ],
      }, {
        saveId: `lotus-bili-download-${this.e.user_id || "user"}`,
      })
      await replyImage(this, image, "[荷花插件]B站下载完成。")
    } catch (error) {
      await this.renderError(options.title || "B站下载", error)
    }
    return true
  }

  async renderError(title, error) {
    const image = await renderStatusCard({
      title,
      subtitle: "荷花插件 Bilibili",
      badge: "失败",
      message: error.message,
      userId: this.e.user_id,
      items: [
        { label: "建议", value: "检查链接是否有效，或稍后重试。" },
      ],
    }, {
      saveId: `lotus-bili-error-${this.e.user_id || "user"}`,
    })
    await replyImage(this, image, `[荷花插件]${title}失败。`)
  }
}

async function createService() {
  const config = await loadGlobalConfig()
  const service = new BilibiliService({
    cookie: config.bilibili?.cookie || config.bilibili?.sessdata || "",
  })
  if (!service.cookie) {
    const stored = await service.loadAccount().catch(() => null)
    if (stored?.cookie) service.cookie = stored.cookie
  }
  return service
}

function cacheKey(e) {
  return e?.isGroup ? `group:${e.group_id}` : `user:${e.user_id}`
}

async function imageFileToDataUrl(file) {
  const buffer = await fs.readFile(file)
  const ext = path.extname(file).toLowerCase()
  const mime = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : "image/png"
  return `data:${mime};base64,${buffer.toString("base64")}`
}

async function sendBiliFile(e, file, config = {}) {
  const stat = await fs.stat(file)
  const sizeMb = stat.size / 1024 / 1024
  const ext = path.extname(file).toLowerCase()
  const segment = globalThis.segment
  if ([".mp4", ".mkv", ".flv", ".mov", ".m4v"].includes(ext)
    && sizeMb <= Number(config.video_size_limit_mb || 100)
    && segment?.video) {
    await e.reply(segment.video(file))
    return
  }

  if (e.isGroup && e.group?.sendFile) return e.group.sendFile(file, path.basename(file))
  if (e.friend?.sendFile) return e.friend.sendFile(file, path.basename(file))
  throw new Error("当前适配器不支持发送文件")
}

function downloadFailureMessage(result = {}) {
  if (result.reason === "duration_limit") {
    return `视频时长超过 ${Math.round(result.limitSeconds / 60)} 分钟限制。`
  }
  if (result.reason === "estimated_size_limit") {
    return `视频预估大小 ${result.estimatedSizeMb} MB 超过 ${result.limitMb} MB 限制。`
  }
  return result.reason || "下载失败"
}

export function buildBilibiliMessageText(e = {}) {
  const chunks = [
    e.raw_message,
    e.msg,
  ]
  for (const item of e.message || []) {
    if ((item?.type === "json" || item?.type === "xml") && item.data) {
      chunks.push(typeof item.data === "string" ? item.data : JSON.stringify(item.data))
    }
    if (item?.type === "text" && item.text) chunks.push(item.text)
  }
  return chunks.filter(Boolean).join("\n")
}
