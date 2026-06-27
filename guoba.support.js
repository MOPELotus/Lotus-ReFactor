import {
  ensureGlobalConfig,
  loadGlobalConfig,
  saveGlobalConfig,
} from "./core/config/global.js"
import { DEFAULT_GLOBAL_CONFIG } from "./core/config/defaults.js"

const ARRAY_FIELDS = new Set([
  "captcha.providers",
  "captcha.test_nine.model_files",
  "remote.allowed_paths",
  "remote.shells",
  "bilibili.download.extra_args",
  "netease_partner.comments",
  "atlas.initial_args",
  "atlas.update_args",
  "atlas.version_args",
  "permissions.users.allow",
  "permissions.users.deny",
  "permissions.groups.allow",
  "permissions.groups.deny",
])

const NUMBER_FIELDS = new Set([
  "render.background_timeout_ms",
  "captcha.refresh.max_attempts",
  "captcha.retry.provider_attempts",
  "captcha.retry.chain_attempts",
  "captcha.notify.recall_seconds",
  "captcha.test_nine.timeout_ms",
  "captcha.ttocr.poll_interval_ms",
  "captcha.ttocr.timeout_ms",
  "captcha.gtmanual.timeout_ms",
  "captcha.gtmanual.poll_interval_ms",
  "captcha.vision_ai.timeout_ms",
  "tools.timeout_ms",
  "tools.download_retries",
  "remote.timeout_ms",
  "remote.output_limit",
  "remote.max_download_bytes",
  "remote.max_upload_bytes",
  "bilibili.search_limit",
  "bilibili.download.resolution",
  "bilibili.download.duration_limit_seconds",
  "bilibili.download.video_size_limit_mb",
  "bilibili.download.max_estimated_size_mb",
  "bilibili.download.cache_ttl_seconds",
  "bilibili.download.timeout_ms",
  "netease_partner.login_timeout_ms",
  "netease_partner.login_poll_ms",
  "netease_partner.delay_ms_min",
  "netease_partner.delay_ms_max",
  "logging.retention_days",
  "atlas.max_results",
  "atlas.update_timeout_ms",
  "atlas.update_output_limit",
])

const CRON_FIELDS = new Set([
  "scheduler.plan_generate_cron",
  "scheduler.run_due_cron",
  "netease_partner.schedule",
  "atlas.auto_update.check_cron",
])

const POLICY_OPTIONS = [
  { label: "继承默认策略", value: "inherit" },
  { label: "允许", value: "allow" },
  { label: "拒绝", value: "deny" },
  { label: "仅主人", value: "master_only" },
]

const SCOPE_LABELS = {
  "checkin.register": "注册签到",
  "checkin.refresh": "刷新签到",
  "checkin.group_register": "注册本群签到",
  "scheduler.generate": "生成签到计划",
  "scheduler.run_due": "执行到期签到",
  "scheduler.manage": "修改调度配置",
  "permissions.manage": "修改权限",
  "remote.spawn": "远程命令",
  "remote.upload": "远程上传",
  "remote.download": "远程下载",
  "atlas.update": "更新图鉴",
  "plugin.update": "更新插件",
  "bilibili.login": "B 站登录",
  "bilibili.download": "B 站下载",
  "tools.install": "安装工具链",
  "group.members.export": "导出群成员",
  "group.cleanup": "退群清理",
  "captcha.manage": "验证码管理",
  "netease.partner": "网易云任务",
}

const GUOBA_SCHEMAS = [
  group("渲染"),
  input("render.background", "随机背景接口", "用于图片背景的接口或本地路径。"),
  input("render.theme_color", "主题色", "用于状态卡和强调色。"),
  number("render.background_timeout_ms", "背景加载超时", "单位毫秒。"),

  group("签到调度"),
  sw("scheduler.enable", "启用自动调度", "关闭后只允许手动签到。"),
  cron("scheduler.plan_generate_cron", "生成计划时间", "每天按此 cron 生成次日签到表。"),
  cron("scheduler.run_due_cron", "到期扫描频率", "扫描到期任务并执行签到。"),
  select("scheduler.mode", "全局签到模式", [
    { label: "固定时间", value: "fixed" },
    { label: "随机时间", value: "random" },
  ], "主人控制的默认模式。"),
  input("scheduler.fixed_time", "固定签到时间", "格式 HH:mm。"),
  input("scheduler.random.window_start", "随机窗口开始", "格式 HH:mm。"),
  input("scheduler.random.window_end", "随机窗口结束", "格式 HH:mm。"),
  sw("scheduler.random.notify_before", "通知随机时间", "生成计划后通知用户次日时间。"),
  sw("scheduler.late_registration.enable", "启用补注册窗口", "计划生成后新增用户进入补注册窗口。"),
  input("scheduler.late_registration.window_start", "补注册窗口开始", "格式 HH:mm。"),
  input("scheduler.late_registration.window_end", "补注册窗口结束", "格式 HH:mm。"),
  sw("scheduler.late_registration.notify", "通知补注册时间", "补注册后通知用户当天时间。"),

  group("验证码链"),
  textArea("captcha.providers", "尝试顺序", "每行一个：test_nine、ttocr、gtmanual、vision_ai。"),
  sw("captcha.refresh.enable_on_challenge_used", "刷新失效 challenge", "遇到 challenge 已使用时重新请求。"),
  number("captcha.refresh.max_attempts", "最大刷新次数", "避免无限重试。"),
  number("captcha.retry.provider_attempts", "单方案尝试次数", "每个自动过码方案最多尝试几次。"),
  number("captcha.retry.chain_attempts", "链路重试轮数", "整条验证码链最多重跑几轮。"),
  sw("captcha.notify.auto_recall", "撤回过码提示", "开启后自动撤回过码提示消息。"),
  number("captcha.notify.recall_seconds", "撤回延迟", "单位秒，0 表示不撤回。"),
  sw("captcha.test_nine.enable", "启用 test_nine", "本地模型过码。"),
  sw("captcha.test_nine.auto_start", "启动 test_nine 服务", "插件加载后自动启动本地服务。"),
  input("captcha.test_nine.endpoint", "test_nine 接口", "默认本机 pass_uni。"),
  number("captcha.test_nine.timeout_ms", "test_nine 超时", "单位毫秒。"),
  input("captcha.test_nine.submodule_path", "test_nine 目录", "子模块目录。"),
  input("captcha.test_nine.venv_path", "test_nine venv", "独立虚拟环境目录。"),
  input("captcha.test_nine.model_dir", "模型目录", "模型文件保存目录。"),
  input("captcha.test_nine.model_repo", "模型仓库", "HuggingFace 仓库名。"),
  textArea("captcha.test_nine.model_files", "模型文件", "每行一个模型文件名。"),
  sw("captcha.test_nine.install_requirements", "安装 test_nine 依赖", "初始化时安装依赖。"),
  sw("captcha.test_nine.download_models", "下载 test_nine 模型", "初始化时下载模型。"),
  sw("captcha.ttocr.enable", "启用 ttocr", "在线打码平台。"),
  input("captcha.ttocr.api", "ttocr 提交接口", "recognize 接口。"),
  input("captcha.ttocr.resapi", "ttocr 结果接口", "results 接口。"),
  password("captcha.ttocr.key", "ttocr 密钥", "平台密钥。"),
  input("captcha.ttocr.query", "ttocr 附加参数", "例如 itemid 和 referer。"),
  number("captcha.ttocr.poll_interval_ms", "ttocr 轮询间隔", "不能低于 1000 毫秒。"),
  number("captcha.ttocr.timeout_ms", "ttocr 超时", "单位毫秒。"),
  sw("captcha.gtmanual.enable", "启用 GT-Manual", "人工过码兜底。"),
  input("captcha.gtmanual.address", "GT-Manual 地址", "服务根地址。"),
  input("captcha.gtmanual.verify_addr", "GT-Manual 链接", "用户点击的验证链接。"),
  number("captcha.gtmanual.timeout_ms", "GT-Manual 超时", "单位毫秒。"),
  number("captcha.gtmanual.poll_interval_ms", "GT-Manual 轮询间隔", "单位毫秒。"),
  sw("captcha.vision_ai.enable", "启用视觉 AI", "自定义视觉模型接口。"),
  input("captcha.vision_ai.api", "视觉 AI 接口", "自定义接口地址。"),
  password("captcha.vision_ai.key", "视觉 AI 密钥", "接口鉴权密钥。"),
  number("captcha.vision_ai.timeout_ms", "视觉 AI 超时", "单位毫秒。"),

  group("Python"),
  select("python.mode", "Python 模式", [
    { label: "虚拟环境", value: "venv" },
    { label: "系统 Python", value: "system" },
  ], "默认使用虚拟环境。"),
  input("python.venv_path", "主 venv 目录", "Lotus Python 环境目录。"),
  input("python.system_python", "系统 Python 路径", "system 模式下使用。"),

  group("工具链"),
  sw("tools.auto_install", "自动准备工具", "初始化时自动下载工具链。"),
  input("tools.dir", "工具目录", "工具保存目录。"),
  input("tools.bin_dir", "可执行文件目录", "命令所在目录。"),
  input("tools.github_api", "GitHub API", "Release 查询接口。"),
  number("tools.timeout_ms", "工具下载超时", "单位毫秒。"),
  number("tools.download_retries", "工具下载重试", "安装包损坏或解压失败时自动重下次数。"),
  sw("tools.bbdown.enable", "启用 BBDown", "B 站视频下载工具。"),
  input("tools.bbdown.repo", "BBDown 仓库", "GitHub owner/repo。"),
  input("tools.bbdown.command", "BBDown 命令", "可执行文件名。"),
  sw("tools.ffmpeg.enable", "启用 ffmpeg", "视频处理工具。"),
  input("tools.ffmpeg.repo", "ffmpeg 仓库", "GitHub owner/repo。"),
  input("tools.ffmpeg.command", "ffmpeg 命令", "可执行文件名。"),
  sw("tools.aria2.enable", "启用 aria2", "下载加速工具。"),
  input("tools.aria2.repo", "aria2 仓库", "GitHub owner/repo。"),
  input("tools.aria2.command", "aria2 命令", "可执行文件名。"),

  group("远程管理"),
  sw("remote.enable", "启用远程管理", "远程命令、上传、下载总开关。"),
  sw("remote.require_otp", "要求一次性验证码", "远程操作必须输入 2FA。"),
  input("remote.otp_secret_env", "OTP 环境变量", "从该环境变量读取 OTP secret。"),
  number("remote.timeout_ms", "命令超时", "单位毫秒。"),
  number("remote.output_limit", "输出长度限制", "超过后截断。"),
  number("remote.max_download_bytes", "下载大小限制", "单位字节。"),
  number("remote.max_upload_bytes", "上传大小限制", "单位字节。"),
  sw("remote.allow_overwrite_upload", "允许覆盖上传", "上传时允许覆盖已有文件。"),
  sw("remote.restrict_file_paths", "限制文件路径", "上传下载只允许指定目录。"),
  textArea("remote.allowed_paths", "允许路径", "每行一个目录。"),
  sw("remote.allow_admin", "允许管理员模式", "仅在受控环境下开启。"),
  textArea("remote.shells", "允许 shell", "每行一个：pwsh、powershell、cmd。"),

  group("B 站"),
  textArea("bilibili.cookie", "B 站 Cookie", "长 Cookie 可直接粘贴。"),
  password("bilibili.sessdata", "B 站 SESSDATA", "只需要 SESSDATA 时填写。"),
  number("bilibili.search_limit", "搜索结果数量", "解析搜索时的最大数量。"),
  sw("bilibili.download.enable", "启用视频下载", "视频解析后允许发送视频。"),
  sw("bilibili.download.use_aria2", "使用 aria2", "可用时交给 aria2 下载。"),
  input("bilibili.download.tools_path", "下载工具目录", "BBDown、ffmpeg、aria2 所在目录。"),
  number("bilibili.download.resolution", "清晰度代码", "BBDown 使用的清晰度编号。"),
  number("bilibili.download.duration_limit_seconds", "视频时长限制", "单位秒。"),
  number("bilibili.download.video_size_limit_mb", "发送大小限制", "单位 MB。"),
  number("bilibili.download.max_estimated_size_mb", "预估大小限制", "0 表示不限制。"),
  select("bilibili.download.multi_page_policy", "分 P 处理方式", [
    { label: "打包发送", value: "zip" },
    { label: "全部下载", value: "all" },
    { label: "只下首 P", value: "first" },
  ]),
  sw("bilibili.download.cache_enable", "启用下载缓存", "复用已下载文件。"),
  number("bilibili.download.cache_ttl_seconds", "缓存保留时间", "0 表示不自动过期。"),
  number("bilibili.download.timeout_ms", "下载超时", "单位毫秒。"),
  textArea("bilibili.download.extra_args", "BBDown 附加参数", "每行一个参数。"),

  group("群数据清理"),
  sw("groups.cleanup.enable", "启用退群清理", "机器人或成员退群时清理记录。"),
  sw("groups.cleanup.dry_run", "仅预览清理", "开启后只记录不删除。"),
  sw("groups.cleanup.remove_group_fallback", "移除群回退", "退群时移除该群作为通知回退。"),
  sw("groups.cleanup.delete_orphan_profiles", "删除孤立配置", "没有可用通知路径时删除 profile。"),
  sw("groups.cleanup.keep_if_private_possible", "保留可私聊用户", "能私聊时保留用户配置。"),

  group("网易云任务"),
  sw("netease_partner.enable", "启用网易云任务", "总开关。"),
  input("netease_partner.api_url", "网易云接口", "本地或远程 API 地址。"),
  cron("netease_partner.schedule", "执行时间", "自动任务 cron。"),
  sw("netease_partner.auto_catch_up", "启动补跑", "错过当天任务后启动补跑。"),
  sw("netease_partner.notify_master", "给主人发结果图", "自动任务完成后私聊给主人发送图片报告。"),
  number("netease_partner.login_timeout_ms", "登录超时", "单位毫秒。"),
  number("netease_partner.login_poll_ms", "登录轮询间隔", "单位毫秒。"),
  number("netease_partner.delay_ms_min", "最小操作间隔", "单位毫秒。"),
  number("netease_partner.delay_ms_max", "最大操作间隔", "单位毫秒。"),
  textArea("netease_partner.comments", "默认评论", "每行一条评论。"),

  group("日志"),
  number("logging.retention_days", "日志保留天数", "超过后可清理。"),
  sw("logging.redact_sensitive", "脱敏日志", "隐藏 cookie、token、密钥等内容。"),

  group("图鉴"),
  input("atlas.data_root", "图鉴数据目录", "保存 map、index、items。"),
  input("atlas.locale", "图鉴语言", "默认简体中文。"),
  number("atlas.max_results", "搜索候选数量", "同名或模糊匹配时使用。"),
  input("atlas.backend_root", "后端目录", "nanoka-atlas-backend 子模块目录。"),
  sw("atlas.sync_after_update", "更新后同步", "后端更新后同步到数据目录。"),
  sw("atlas.sync_gallery", "同步图片资源", "同步 gallery 图片。"),
  input("atlas.initial_command", "全量命令", "首次全量抓取命令。"),
  textArea("atlas.initial_args", "全量参数", "每行一个参数。"),
  input("atlas.update_command", "增量命令", "增量更新命令。"),
  textArea("atlas.update_args", "增量参数", "每行一个参数。"),
  input("atlas.version_command", "版本检查命令", "检查远端版本命令。"),
  textArea("atlas.version_args", "版本检查参数", "每行一个参数。"),
  number("atlas.update_timeout_ms", "图鉴更新超时", "单位毫秒。"),
  number("atlas.update_output_limit", "图鉴输出限制", "超过后截断。"),
  sw("atlas.auto_update.enable", "启用图鉴定时更新", "按版本变化自动增量更新。"),
  cron("atlas.auto_update.check_cron", "图鉴检查频率", "检查版本变化的 cron。"),
  sw("atlas.auto_update.run_on_missing_data", "缺数据时全量抓取", "首次缺数据时自动全量抓取。"),

  group("权限"),
  select("permissions.default_policy", "默认权限", [
    { label: "允许", value: "allow" },
    { label: "拒绝", value: "deny" },
  ], "未单独设置时使用。"),
  textArea("permissions.users.allow", "允许用户", "每行一个 QQ。"),
  textArea("permissions.users.deny", "拒绝用户", "每行一个 QQ。"),
  textArea("permissions.groups.allow", "允许群", "每行一个群号。"),
  textArea("permissions.groups.deny", "拒绝群", "每行一个群号。"),
  ...Object.keys(DEFAULT_GLOBAL_CONFIG.permissions.scopes).map(scope => select(
    `permissions.scopes["${scope}"].policy`,
    SCOPE_LABELS[scope] || scope,
    POLICY_OPTIONS,
    `权限范围：${scope}`,
  )),
]

export function supportGuoba() {
  return {
    pluginInfo: {
      name: "Lotus-Plugin",
      title: "荷花插件",
      author: "Lotus",
      authorLink: "https://github.com/MOPELotus",
      link: "https://github.com/MOPELotus/Lotus-ReFactor",
      isV3: true,
      isV2: false,
      description: "米哈游登录、签到、图鉴、工具链与远程管理。",
      icon: "mdi:flower-tulip-outline",
      iconColor: "#66ccff",
    },
    configInfo: {
      schemas: GUOBA_SCHEMAS,
      async getConfigData() {
        await ensureGlobalConfig()
        return toGuobaFormData(await loadGlobalConfig())
      },
      async setConfigData(data, { Result }) {
        try {
          const current = await loadGlobalConfig({ createIfMissing: true })
          const next = applyGuobaFormData(current, data)
          await saveGlobalConfig(next)
          return Result.ok({}, "保存成功")
        } catch (error) {
          return Result.error(`保存失败：${error.message}`)
        }
      },
    },
  }
}

export function toGuobaFormData(config) {
  const result = {}
  for (const schema of GUOBA_SCHEMAS) {
    if (!schema.field) continue
    let value = getPath(config, schema.field)
    if (CRON_FIELDS.has(schema.field)) value = quartzCronToGuobaCron(value)
    setPath(result, schema.field, ARRAY_FIELDS.has(schema.field) ? arrayToText(value) : value)
  }
  return result
}

export function applyGuobaFormData(config, data = {}) {
  const next = structuredClone(config)
  for (const schema of GUOBA_SCHEMAS) {
    if (!schema.field || !hasSubmittedValue(data, schema.field)) continue
    let value = getSubmittedValue(data, schema.field)
    if (ARRAY_FIELDS.has(schema.field)) value = textToArray(value)
    if (NUMBER_FIELDS.has(schema.field)) value = toNumber(value)
    setPath(next, schema.field, value)
  }
  return next
}

export { GUOBA_SCHEMAS }

function group(label) {
  return {
    component: "Divider",
    label,
  }
}

function input(field, label, bottomHelpMessage = "") {
  return {
    field,
    label,
    bottomHelpMessage,
    component: "Input",
    componentProps: {
      placeholder: label,
    },
  }
}

function password(field, label, bottomHelpMessage = "") {
  return {
    field,
    label,
    bottomHelpMessage,
    component: "InputPassword",
    componentProps: {
      placeholder: label,
    },
  }
}

function textArea(field, label, bottomHelpMessage = "") {
  return {
    field,
    label,
    bottomHelpMessage,
    component: "InputTextArea",
    componentProps: {
      rows: 3,
      placeholder: label,
    },
  }
}

function number(field, label, bottomHelpMessage = "") {
  return {
    field,
    label,
    bottomHelpMessage,
    component: "InputNumber",
    componentProps: {
      min: 0,
      placeholder: label,
      style: {
        width: "100%",
      },
    },
  }
}

function sw(field, label, bottomHelpMessage = "") {
  return {
    field,
    label,
    bottomHelpMessage,
    component: "Switch",
  }
}

function select(field, label, options, bottomHelpMessage = "") {
  return {
    field,
    label,
    bottomHelpMessage,
    component: "Select",
    componentProps: {
      options,
      placeholder: label,
    },
  }
}

function cron(field, label, bottomHelpMessage = "") {
  return {
    field,
    label,
    bottomHelpMessage,
    component: "EasyCron",
    componentProps: {
      placeholder: label,
    },
  }
}

function hasSubmittedValue(data, field) {
  if (Object.prototype.hasOwnProperty.call(data, field)) return true
  return getPath(data, field) !== undefined
}

function getSubmittedValue(data, field) {
  if (Object.prototype.hasOwnProperty.call(data, field)) return data[field]
  return getPath(data, field)
}

function arrayToText(value) {
  return Array.isArray(value) ? value.join("\n") : ""
}

function textToArray(value) {
  if (Array.isArray(value)) return value.map(item => String(item).trim()).filter(Boolean)
  return String(value || "")
    .split(/[\n,]/)
    .map(item => item.trim())
    .filter(Boolean)
}

function quartzCronToGuobaCron(value = "") {
  const parts = String(value || "").trim().split(/\s+/).filter(Boolean)
  if (!parts.length) return value
  return parts.map(part => part === "?" ? "*" : part).join(" ")
}

function toNumber(value) {
  if (value === "" || value === null || typeof value === "undefined") return 0
  return Number(value)
}

function getPath(target, path) {
  let current = target
  for (const key of parsePath(path)) {
    if (current == null) return undefined
    current = current[key]
  }
  return current
}

function setPath(target, path, value) {
  const keys = parsePath(path)
  let current = target
  for (let index = 0; index < keys.length - 1; index++) {
    const key = keys[index]
    if (!current[key] || typeof current[key] !== "object") current[key] = {}
    current = current[key]
  }
  current[keys[keys.length - 1]] = value
  return target
}

function parsePath(path) {
  const keys = []
  const pattern = /([^.[\]]+)|\["([^"]+)"\]|\['([^']+)'\]/g
  let match
  while ((match = pattern.exec(path))) {
    keys.push(match[1] || match[2] || match[3])
  }
  return keys
}
