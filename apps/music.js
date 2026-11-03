const BasePlugin = globalThis.plugin
import { LOTUS_INTERCEPT_PRIORITY } from "../core/intercept/priority.js"
import { loadGlobalConfig } from "../core/config/global.js"
import { renderStatusCard, renderTemplate } from "../core/render/service.js"
import { replyImage, replyText } from "../core/transport/reply.js"
import { MusicService, MUSIC_PLATFORMS, MUSIC_QR_TYPES, musicSessionKey, musicShare } from "../services/music/service.js"

const sessions = new Map(), aliases = { 网易云: "netease", 网易: "netease", QQ: "qq", qq: "qq", QQ音乐: "qq", 酷狗: "kugou", 酷我: "kuwo", 咪咕: "migu", 汽水: "soda" }
setInterval(() => { for (const [key, value] of sessions) if (value.expires <= Date.now()) { value.controller?.abort();sessions.delete(key) } }, 30000).unref()
async function service() {
  const config = await loadGlobalConfig()
  if (config.music?.enable === false) throw new Error("点歌功能已关闭")
  return { service: new MusicService({ tuneweaveConfig: config.tuneweave, config: config.music, toolsPath: config.tools?.bin_dir }), config: config.music || {} }
}
export class LotusMusic extends BasePlugin {
  constructor() {
    super({ name: "[Lotus-Plugin] Music", dsc: "按平台点歌与公共账号登录", event: "message", priority: LOTUS_INTERCEPT_PRIORITY,
      rule: [
        { reg: "^#(?:荷花)?(?:(?:网易云|网易|QQ音乐|QQ|qq|酷狗|酷我|咪咕|汽水))?(?:点歌|搜歌)[\\s\\S]*$", fnc: "search" },
        { reg: "^#(?:荷花)?音乐登录$", fnc: "login" },
        { reg: "^(?:[0-9]+|#听[0-9]+|#(?:音乐)?下一页|#(?:取消|音乐取消))$", fnc: "choice" },
        { reg: "^#音乐帮助$", fnc: "help" },
      ] })
  }
  async init() { try { await (await service()).service.adoptPartnerAccount() } catch (error) { globalThis.logger?.debug?.(`[Lotus-Plugin] 音乐账号接续：${error.message}`) } }
  async help(e = this.e) { await replyText(e, "点歌：#网易点歌 歌名 / #QQ点歌 歌名 / #酷狗点歌 歌名\n也支持酷我、咪咕、汽水；#点歌 默认网易云。搜索后输入数字选歌，#下一页 翻页，#取消 结束。默认发送音乐卡片和完整语音，播放自动回退音源。建议主人 #音乐登录 扫码；网易云与 #合伙人登录 共用账号。");return true }
  async search() {
    const e = this.e
    try {
      const { service: api, config } = await service()
      const match = String(e.msg).match(/^#(?:荷花)?(网易云|网易|QQ音乐|QQ|qq|酷狗|酷我|咪咕|汽水)?(?:点歌|搜歌)\s*([\s\S]*)$/)
      const keyword = match?.[2]?.trim()
      if (!keyword) return this.help(e)
      const key = musicSessionKey(e), previous = sessions.get(key)
      previous?.controller?.abort()
      const session = { stage: "search", api, platform: aliases[match[1]] || config.default_platform || "netease", keyword, page: 1, expires: Date.now() + (config.session_timeout_ms || 120000), config }
      sessions.set(key, session)
      await this.results(session,e)
    } catch (error) { await replyText(e, `[荷花点歌]${error.message}`) }
    return true
  }
  async results(session, e = this.e) {
    const key = musicSessionKey(e)
    session.loading = true
    try {
      const tracks = await session.api.search(session.platform, session.keyword, session.page)
      if (sessions.get(key) !== session) return
      session.tracks = tracks
      session.expires = Date.now() + (session.config.session_timeout_ms || 120000)
    } finally { session.loading = false }
    const image = await renderStatusCard({ title: MUSIC_PLATFORMS[session.platform] + "点歌", subtitle: session.keyword, badge: `第 ${session.page} 页`, userId: e.user_id,
      message: session.tracks.length ? "两分钟内回复数字选歌；#下一页 翻页，#取消 结束。播放时自动尝试完整备用音源。建议主人扫码登录。" : "没有搜索结果，可更换关键词或平台。",
      items: session.tracks.map((track, i) => ({ label: String(i + 1), value: `${track.name} · ${track.artists?.map(a => a.name).join(" / ") || "未知歌手"}` })) }, { saveId: `lotus-music-search-${e.user_id}` })
    if (sessions.get(key) === session) await replyImage(e, image, session.tracks.map((track, i) => `${i + 1}. ${track.name}`).join("\n") || "没有搜索结果")
  }
  async login() {
    const e = this.e
    if (!e.isMaster) { await replyText(e, "只有机器人主人可以维护公共音乐账号。");return true }
    try {
      const { service: api, config } = await service(), platforms = (await api.platforms()).filter(p => p.capabilities.includes("qr_login"))
      const key = musicSessionKey(e);sessions.get(key)?.controller?.abort()
      sessions.set(key, { stage: "platform", api, platforms, expires: Date.now() + (config.session_timeout_ms || 120000), config })
      await replyText(e, "请选择扫码平台：\n" + platforms.map((p, i) => `${i + 1}. ${p.name}`).join("\n") + "\n输入数字继续，#取消 退出。网易云与合伙人登录共用。")
    } catch (error) { await replyText(e, `[荷花音乐]${error.message}`) }
    return true
  }
  async choice() {
    const e = this.e
    const key = musicSessionKey(e), session = sessions.get(key)
    if (!session || session.expires <= Date.now()) { session?.controller?.abort();sessions.delete(key);return false }
    const text = String(e.msg || "").trim()
    if (/^#(?:音乐)?取消$/.test(text)) { session.controller?.abort();sessions.delete(key);await replyText(e,"已取消本次音乐操作。");return true }
    try {
      if (session.stage === "search") {
        if (session.loading) { await replyText(e, "正在搜索，请稍候。");return true }
        if (/^#(?:音乐)?下一页$/.test(text)) {session.page++;try{await this.results(session,e)}catch(error){session.page--;throw error}return true}
        const track = session.tracks?.[Number(text.replace(/^#听/, "")) - 1]
        if (!track) { await replyText(e,`请输入 1–${session.tracks?.length || 0} 的序号。`);return true }
        sessions.delete(key)
        await replyText(e,`正在获取《${track.name}》完整音源…`)
        let media
        try {
          media = await session.api.prepare(track)
          const share = musicShare(track,media.stream)
          let cardSent=false
          if(share) {try {const result=await e.reply(share);cardSent=result!==false&&!result?.error&&!(Array.isArray(result)&&result.some(r=>r?.error))}catch{}}
          if(!cardSent)await replyImage(e,await renderStatusCard({title:track.name,subtitle:track.artists?.map(a=>a.name).join(" / "),badge:MUSIC_PLATFORMS[track.platform],avatar:track.album?.cover_url,userId:e.user_id,message:`完整音频 · ${Math.round(media.duration)} 秒`,items:[{label:"实际音源",value:MUSIC_PLATFORMS[media.stream.resolved_platform]||media.stream.resolved_platform}]}),`${track.name} · ${track.artists?.map(a=>a.name).join(" / ")}`)
          const record=await(globalThis.segment?.record?globalThis.segment.record(media.voiceFile):{type:"record",file:media.voiceFile})
          const result=await e.reply(record)
          if(result===false||result?.error||Array.isArray(result)&&result.some(r=>r?.error))throw new Error("语音发送失败")
        } finally {if(media)await session.api.cleanup(media)}
      } else {
        if(!e.isMaster)throw new Error("只有机器人主人可以维护音乐登录")
        const index=Number(text)-1
        if(session.stage==="platform") {
          const selected=session.platforms[index];if(!selected)throw new Error("请选择列表中的平台序号")
          session.platform=selected.platform
          if(MUSIC_QR_TYPES[session.platform]){session.stage="type";session.types=MUSIC_QR_TYPES[session.platform];await replyText(e,"请选择扫码方式：\n"+session.types.map((t,i)=>`${i+1}. ${t.name}`).join("\n"));return true}
          await this.qr(session,key,undefined,e)
        } else if(session.stage==="type") {
          const type=session.types[index];if(!type)throw new Error("请选择列表中的扫码方式序号")
          await this.qr(session,key,type.type,e)
        }
      }
    } catch(error) {await replyText(e,`[荷花音乐]${error.message}`)}
    return true
  }
  async qr(session,key,type,e = this.e) {
    session.stage="polling";session.expires=Date.now()+180000;session.controller=new AbortController()
    try {
      const login=await session.api.createLogin(session.platform,e.user_id,type)
      if(session.controller.signal.aborted || sessions.get(key)!==session)return
      await replyImage(e,await renderTemplate("qr-login",{title:MUSIC_PLATFORMS[session.platform]+"登录",subtitle:"公共音乐账号",badge:"SCAN",notice:"建议使用对应平台 App 扫码确认。账号供机器人点歌使用，#取消 可结束等待。",qrDataUrl:login.image,profileId:session.platform}),"音乐登录二维码已生成")
      await session.api.waitLogin(login,{signal:session.controller.signal})
      if(!session.controller.signal.aborted)await replyText(e,`${MUSIC_PLATFORMS[session.platform]}公共音乐账号已登录。`)
    } catch(error) {if(!session.controller.signal.aborted)throw error}
    finally{if(sessions.get(key)===session)sessions.delete(key)}
  }
}
