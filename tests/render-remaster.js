// Explicit physical-GPU previews. Reference fixtures contain real game names/assets.
import fs from 'node:fs/promises'
import path from 'node:path'
import assert from 'node:assert/strict'
import QRCode from 'qrcode'
import { NanokaAtlasService, buildAtlasRenderData } from '../services/nanokaAtlas/service.js'
import { buildAtlasPages, renderAtlasPage } from '../core/render/atlas-pages.js'
import { renderTemplate } from '../core/render/service.js'
const out = path.resolve(process.argv[2] || 'temp/atlas-remaster/previews')
await fs.mkdir(out,{recursive:true})
const service = new NanokaAtlasService({config:{data_root:path.resolve('temp/atlas-remaster/snapshot')}})
const report = {books:[],cards:[],hardware:[]}, characters={}
function onRender(engine) {
 assert.equal(engine.gpu,true);assert.equal(engine.renderer,'GPU');assert.match(engine.device,/NVIDIA RTX A4000/)
 assert.doesNotMatch(JSON.stringify(engine),/llvmpipe|lavapipe|SwiftShader/i)
 assert.deepEqual(engine.missingImages || [],[])
 report.hardware.push(engine)
}
for(const [game,name] of [['原神','神里绫华'],['星铁','流萤'],['绝区零','星见雅']]) {
 const result=await service.search(name,{game,pages:['角色'],strict:true})
 assert.equal(result.ok,true);const data=buildAtlasRenderData(result);delete data.item.raw
 characters[game]=data
 const dir=path.join(out,game);await fs.mkdir(dir,{recursive:true})
 const pages=buildAtlasPages(data),files=[]
 for(const page of pages) {
  const base=`${name}-${String(page.index).padStart(2,'0')}-${page.section}`
  await renderAtlasPage({...data,atlasPage:page},{path:path.join(dir,`${base}-4x.jpg`),onRender})
  await renderAtlasPage({...data,atlasPage:page},{path:path.join(dir,`${base}-preview.jpg`),renderScale:1,onRender})
  files.push({page:page.index,section:page.section,highResolution:`${game}/${base}-4x.jpg`,preview:`${game}/${base}-preview.jpg`})
 }
 report.books.push({game,name,pages:pages.length,sections:[...new Set(pages.map(p=>p.section))],files})
}
const gi=characters['原神'],sr=characters['星铁'],zzz=characters['绝区零']
const base={title:'荷花插件',subtitle:'参考数据 · 模板验证',badge:'LOTUS',image:gi.image}
const team=[{name:'神里绫华',icon:gi.image,elem:'冰',level:90,cons:0,weapon:'雾切之回光',weaponAffix:1,weaponLevel:90,stats:{暴击率:45,暴击伤害:220,元素充能效率:140}}]
const summary=[{label:'总伤害',value:'125.6万'},{label:'DPS',value:'6.28万'},{label:'时间',value:'20秒'},{label:'评级',value:'SS'}]
const fixtures={
 status:{...base,title:'图鉴更新完成',message:'三游戏图鉴已准备就绪。',items:[{label:'原神',value:'角色／武器／圣遗物'},{label:'星铁',value:'角色／光锥／遗器'},{label:'绝区零',value:'代理人／音擎／驱动盘'},{label:'清晰度',value:'4倍渲染'}]},
 'qr-login':{...base,title:'米游社扫码登录',notice:'样式参考；二维码内容为米游社首页。',qrDataUrl:await QRCode.toDataURL('https://www.miyoushe.com/'),profileId:1},
 'profile-card':{...base,title:'账号资料卡',summary:'三游戏绑定信息',account:[{label:'账号',value:'旅行者'},{label:'状态',value:'已绑定'}],roles:[{label:'原神',value:'神里绫华'},{label:'星铁',value:'流萤'},{label:'绝区零',value:'星见雅'}],settings:[{label:'游戏签到',value:'开启'},{label:'社区签到',value:'开启'}]},
 'daily-note-summary':{...base,title:'三游戏体力',groups:[{name:'profile 1',items:[{gameName:'原神',nickname:'旅行者',ok:true,detail:'树脂 160/200 · 每日委托已完成',details:[{label:'洞天宝钱',value:'1200/2400'},{label:'探索派遣',value:'5项完成'}]},{gameName:'星铁',nickname:'开拓者',ok:true,detail:'开拓力 180/300 · 每日实训已完成'},{gameName:'绝区零',nickname:'绳匠',ok:true,detail:'电量 180/240 · 活跃度已完成'}]}]},
 'checkin-result':{...base,title:'签到完成',games:['原神','星铁','绝区零'].map(label=>({label,game:'成功',community:'成功'}))},
 'schedule-notice':{...base,title:'明日签到计划',items:[{label:'profile',value:'1'},{label:'时间',value:'08:30'},{label:'范围',value:'三游戏'},{label:'社区',value:'已开启'}]},
 'genshin-team-damage':{...base,title:'原神队伍伤害',team,summary,pie:[{char:'神里绫华',damage:1256000}],actions:['神里绫华元素爆发','神里绫华重击']},
 'starrail-team-damage':{...base,title:'星铁队伍伤害',image:sr.image,summary,pie:[{char:'流萤',damage:1256000}],team:[{name:'流萤',icon:sr.image,elem:'火',path:'毁灭',level:80,rank:0,weapon:'梦应归于何处',weaponRank:1,weaponLevel:80,stats:{暴击率:'5%',暴击伤害:'50%',速度:150,击破:'240%'},panelSource:'参考面板'}],actionTrack:[{name:'流萤',order:1,actionPoints:66.7}]},
 'starrail-challenge':{...base,title:'星铁挑战战绩',uid:'101623059',demo:true,results:[{kind:'story',label:'虚构叙事',period:'2026年10月',stars:12,battleNum:2,floors:[{title:'虚构叙事 · 第四关',score:80000,stars:3,nodes:[{label:'上半',score:40000,avatars:[{name:'流萤',icon:sr.image,rank:0,rarity:5,level:80}]},{label:'下半',score:40000,avatars:[{name:'流萤',icon:sr.image,rank:0,rarity:5,level:80}]}]}]}]},
 'achievement-index':{...base,title:'原神成就目录',summary:[{label:'已完成',value:'40/50'},{label:'原石',value:'200/250'}],categories:[{name:'天地万象',icon:gi.image,completed:40,total:50,pointsDone:200,pointsTotal:250,percent:80}]},
 'achievement-category':{...base,title:'天地万象',groups:[{name:'风与异乡人',done:true,completed:1,total:1,pointsDone:5,pointsTotal:5,stages:[{name:'风与异乡人',desc:'完成「捕风的异乡人」。',done:true,points:5,progress:'1/1',stageIndex:1,stageTotal:1}]}]},
 'atlas-result':{...base,title:'图鉴搜索结果',items:[gi,sr,zzz].map(d=>({title:d.title,image:d.image,meta:d.view.game,desc:d.view.description}))},
 'douyin-info':{...base,title:'角色图鉴展示',type:'gallery',id:'7372484719365098803',owner:'荷花插件',cover:zzz.image,createdAt:1791072000,media:[{},{},{}],stat:{like:1256,reply:100,favorite:200,share:50},desc:'三游戏角色图鉴样式验证。'},
 'douyin-article':{...base,title:'角色图鉴说明',owner:'荷花插件',page:1,blocks:[{type:'text',text:'每个角色的总览、技能、被动、命座与可用养成材料按顺序显示。'},{type:'image',urls:[gi.image]}]},
 'bilibili-info':{...base,title:'神里绫华角色展示',type:'video',id:'BV17x411w7KC',owner:'荷花插件',cover:gi.image,duration:120,stat:{like:1256,favorite:200,coin:500,view:5000,danmaku:100,reply:100}},
}
const dir=path.join(out,'cards');await fs.mkdir(dir,{recursive:true})
for(const [template,data] of Object.entries(fixtures)) {
 await renderTemplate(template,data,{path:path.join(dir,`${template}-4x.jpg`),onRender})
 await renderTemplate(template,data,{path:path.join(dir,`${template}-preview.jpg`),renderScale:1,onRender})
 report.cards.push(template)
}
await fs.writeFile(path.join(out,'manifest.json'),JSON.stringify(report,null,2))
console.log(JSON.stringify({books:report.books.map(({game,name,pages})=>({game,name,pages})),cards:report.cards.length,engine:report.hardware[0]}))
