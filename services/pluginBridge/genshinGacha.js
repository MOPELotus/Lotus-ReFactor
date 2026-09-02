import { importRuntimeModule } from "./common.js"

export class GenshinGachaDisplayBridge {
  constructor(options = {}) {
    this.loadGachaLog = options.loadGachaLog || loadGachaLog
    this.loadGcLogApp = options.loadGcLogApp || loadGcLogApp
  }

  async render({ e, qq, uid, viewMessage = "#原神角色记录" } = {}) {
    if (!qq || !uid) throw new Error("miao 原神抽卡渲染缺少 QQ 或 UID")
    const [GachaLog, GcLogApp] = await Promise.all([this.loadGachaLog(), this.loadGcLogApp()])
    const event = createRenderEvent(e, qq, uid, viewMessage)
    const model = new GachaLog(event)
    model.uid = String(uid)
    model.isLogUrl = true
    model.all = []
    const renderData = await model.getLogData()
    if (!renderData || renderData === true) throw new Error("该 UID 暂无原神抽卡记录，请先更新抽卡记录")

    const renderer = new GcLogApp()
    renderer.e = event
    renderer.reply = event.reply.bind(event)
    const template = event.isAll ? "html/gacha/gacha-all-log" : "html/gacha/gacha-log"
    const image = await renderer.renderImg("genshin", template, renderData, { retType: "base64" })
    if (!image) throw new Error("miao 原神抽卡模板渲染失败")
    return { image, button: renderer.button, renderData }
  }
}

function createRenderEvent(e, qq, uid, viewMessage) {
  return {
    ...e,
    msg: viewMessage,
    original_msg: viewMessage,
    isAll: /全部/.test(String(viewMessage)),
    isSr: false,
    game: "gs",
    uid: String(uid),
    user_id: String(qq),
    isPrivate: true,
    reply: async () => true,
  }
}

async function loadGachaLog() {
  return (await importRuntimeModule("genshin", "model", "gachaLog.js")).default
}

async function loadGcLogApp() {
  return (await importRuntimeModule("genshin", "apps", "gcLog.js")).gcLog
}
