import path from "node:path"
import { pathToFileURL } from "node:url"
import { rootPath } from "../../core/path.js"
import { loadGlobalConfig } from "../../core/config/global.js"
import { notifyUser } from "../../core/transport/notify.js"
import { BBDOWN_VERSION, ToolInstallerService, findCommandExecutable, normalizeToolsConfig } from "./installer.js"

const STARTUP_DELAY = 5 * 60 * 1000
let startupScheduled = false

export async function notifyBBDownMasters(message) {
  let runtime = globalThis.Bot?.config || globalThis.Bot?.cfg || {}
  // TRSS 的主人配置由 cfg 提供，不一定挂在 Bot 上。
  try { runtime = (await import(pathToFileURL(path.resolve(rootPath, "../../lib/config/config.js")).href)).default } catch {}
  const values = [runtime.masterQQ, runtime.master, runtime.master_qq, runtime.masters]
  const masters = [...new Set(values.flat().filter(value => value != null && value !== "").map(String))]
  for (const master of masters) {
    try {
      const result = await notifyUser(master, message, { prefer: "private", onlyKnownFriend: false })
      if (!result.ok) globalThis.logger?.warn?.(`[Lotus-Plugin] BBDown 主人通知失败：${result.reason}`)
    } catch (error) { globalThis.logger?.warn?.(`[Lotus-Plugin] BBDown 主人通知失败：${error.message}`) }
  }
}

export async function checkBBDownUpdate(config, installer) {
  const tools = normalizeToolsConfig(config.tools)
  // 更新下载服务实际使用的目录，兼容用户自定义 tools_path。
  tools.bin_dir = config.bilibili?.download?.tools_path || tools.bin_dir
  if (!tools.auto_install || !tools.bbdown.enable) return { needed: false, tools }
  const service = installer || new ToolInstallerService({ config: tools })
  const executable = await findCommandExecutable(tools.bbdown.command, [tools.bin_dir], service.platform)
  const version = await service.readBBDownVersion(executable)
  return { needed: version !== BBDOWN_VERSION, tools, version, service }
}

export async function updateBBDownAfterStartup({ config, installer, notify = notifyBBDownMasters } = {}) {
  // 到执行时重新检测，避免五分钟内用户手动更新后重复下载和通知。
  const state = await checkBBDownUpdate(config || await loadGlobalConfig(), installer)
  if (!state.needed) return { ok: true, skipped: true }
  const sendNotice = async message => {
    try { await notify(message) } catch (error) {
      globalThis.logger?.warn?.(`[Lotus-Plugin] BBDown 更新通知失败：${error.message}`)
    }
  }
  await sendNotice(`[荷花插件]原版 BBDown 已长期停更，部分功能已不可用。现切换至荷花维护的 Fork 修复版（${BBDOWN_VERSION}），正在自动更新，请稍候。`)
  try {
    const result = await state.service.ensureTool("bbdown", state.tools)
    await sendNotice(`[荷花插件]BBDown 已自动更新至荷花 Fork ${BBDOWN_VERSION}。`)
    return result
  } catch (error) {
    await sendNotice(`[荷花插件]BBDown 自动更新失败：${error.message}。可稍后使用 #初始化工具环境 重试。`)
    throw error
  }
}

export async function scheduleBBDownStartupUpdate(config, { schedule = setTimeout, installer } = {}) {
  if (startupScheduled) return
  startupScheduled = true
  const started = Date.now()
  const state = await checkBBDownUpdate(config, installer)
  if (!state.needed) {
    globalThis.logger?.info?.(`[Lotus-Plugin] BBDown ${state.version || "自动安装已禁用"}，无需开机更新`)
    return
  }
  globalThis.logger?.info?.(`[Lotus-Plugin] BBDown ${state.version || "未安装或版本未知"}，将在开机五分钟后自动更新至 ${BBDOWN_VERSION}`)
  // 以机器人进程启动时间为准；只在插件热加载时启动则已过五分钟可立即执行。
  const bootTime = started - process.uptime() * 1000
  const timer = schedule(() => {
    void updateBBDownAfterStartup({ installer }).catch(error => {
      globalThis.logger?.error?.(`[Lotus-Plugin] BBDown 自动更新失败：${error.message}`)
    })
  }, Math.max(0, bootTime + STARTUP_DELAY - Date.now()))
  timer?.unref?.()
  return timer
}
