import fs from 'node:fs/promises'
import path from 'node:path'
import {existsSync} from 'node:fs'
import {Canvas,FontLibrary,loadImage} from 'skia-canvas'
import {resourcesPath} from '../path.js'
import {fetchImageBytes} from './image.js'
import {plainGameText} from './plain-text.js'
import {encodeGpuCanvas} from './gpu-buffer.js'

const ROOT=path.join(resourcesPath,'source-templates')
const GOLD='#d3bc8e',WHITE='#fff',INK='#414e64'
const TEXT='"SourceMiao", MiSans, sans-serif'
const NUMBER='"SourceNumber", "SourceMiao", MiSans, sans-serif'
const TITLE='"SourceTitle", "SourceMiao", MiSans, sans-serif'
let fontsLoaded=false
const cache=new Map()

export const SOURCE_CARD_TEMPLATES=Object.freeze({
 'profile-card':'genshin/html/user/uid-list.html',
 'daily-note-summary':'genshin/html/player/daily-note-gs.html',
 'checkin-result':'miao/character/profile-stat.html',
 'schedule-notice':'miao/help/version-info.html',
 'status':'miao/help/version-info.html',
 'qr-login':'miao/help/index.html',
 'genshin-team-damage':'miao/character/profile-stat.html',
 'starrail-team-damage':'miao/character/profile-stat.html',
 'achievement-index':'miao/character/profile-stat.html',
 'achievement-category':'miao/character/profile-stat.html',
 'zzz-rank':'miao/character/rank-profile-list.html',
 'douyin-info':'genshin/html/mysNews/mysNews.html',
 'douyin-article':'genshin/html/mysNews/mysNews.html',
 'bilibili-info':'genshin/html/mysNews/mysNews.html',
 'atlas-result':'genshin/html/mysNews-list/mysNews-list.html',
})

function init(){
 if(fontsLoaded)return
 FontLibrary.use('SourceMiao',[path.join(resourcesPath,'miao-theme/fonts/HYWH-65W.ttf')])
 FontLibrary.use('SourceNumber',[path.join(ROOT,'miao-stat/fonts/tttgbnumber.ttf')])
 FontLibrary.use('SourceTitle',[path.join(ROOT,'miao-stat/fonts/NZBZ.ttf')])
 FontLibrary.use('MiSans',[path.join(resourcesPath,'fonts/MiSans-VF.ttf')])
 fontsLoaded=true
}
function resolveImage(src){
 if(/^\/meta-(?:gs|sr)\//.test(src))return path.join(process.cwd(),'plugins/miao-plugin/resources',src)
 if(/^file:\/\//.test(src))return new URL(src)
 return src
}
async function getImage(src){
 if(!src)return null
 const key=String(src)
 if(!cache.has(key)){
  const resolved=resolveImage(key)
  cache.set(key,(async()=>loadImage(/^https?:\/\//i.test(key)?await fetchImageBytes(key):resolved))().catch(()=>{cache.delete(key);return null}))
  if(cache.size>96)cache.delete(cache.keys().next().value)
 }
 return cache.get(key)
}

// Drawing primitives only. Layout and information order are defined separately
// for each original HTML/CSS template below; no old Lotus hero/grid/card shell.
class SourceCanvas{
 constructor(width){this.width=width;this.y=20;this.commands=[];this.refs=new Set();this.canvas=new Canvas(width,10);this.ctx=this.canvas.getContext('2d')}
 lines(value,width,size=16,font=TEXT){
  this.ctx.font=`${size}px ${font}`
  const lines=[]
  for(const paragraph of plainGameText(value).split(/\r?\n/)){
   let line=''
   for(const token of paragraph.match(/[-+]?\d+(?:\.\d+)?%?|[A-Za-z][A-Za-z0-9.-]*|./gu)||[]){
    if(this.ctx.measureText(token).width<=width){if(line&&this.ctx.measureText(line+token).width>width){lines.push(line);line=''}line+=token}
    else for(const ch of token){if(line&&this.ctx.measureText(line+ch).width>width){lines.push(line);line=''}line+=ch}
   }
   lines.push(line)
  }
  return lines
 }
 rect(x,y,w,h,fill,radius=0){this.commands.push(ctx=>{ctx.fillStyle=fill;ctx.beginPath();ctx.roundRect(x,y,w,h,radius);ctx.fill()})}
 clip(x,y,w,h,radius=10){this.commands.push(ctx=>{ctx.save();ctx.beginPath();ctx.roundRect(x,y,w,h,radius);ctx.clip()})}
 restore(){this.commands.push(ctx=>ctx.restore())}
 rule(x,y,w,color='#ddd'){this.rect(x,y,w,1,color)}
 text(value,x,y,width,size=16,color=WHITE,options={}){
  const font=options.font||TEXT
  let lines
  if(options.singleLine){
   lines=[plainGameText(value).replace(/\s*\n\s*/g,' ')]
   this.ctx.font=`${size}px ${font}`
   while(this.ctx.measureText(lines[0]).width>width&&size>(options.minSize||10)){size-=.5;this.ctx.font=`${size}px ${font}`}
  }else lines=this.lines(value,width,size,font)
  const leading=options.leading||size*1.5
  this.commands.push(ctx=>{ctx.save();ctx.font=`${size}px ${font}`;ctx.textBaseline='top';ctx.fillStyle=color;ctx.textAlign=options.align||'left';if(options.shadow){ctx.shadowColor='#000';ctx.shadowBlur=2;ctx.shadowOffsetX=1;ctx.shadowOffsetY=1}lines.forEach((line,i)=>ctx.fillText(line,x+(options.align==='right'?width:options.align==='center'?width/2:0),y+i*leading));ctx.restore()})
  return lines.length*leading
 }
 image(src,x,y,w,h,options={}){
  if(!src)return
  this.refs.add(src)
  this.commands.push((ctx,images)=>{
   const img=images.get(src);if(!img)return
   ctx.save()
   if(options.radius){ctx.beginPath();ctx.roundRect(x,y,w,h,options.radius);ctx.clip()}
   const ratio=(options.cover?Math.max:Math.min)(w/img.width,h/img.height),dw=img.width*ratio,dh=img.height*ratio
   ctx.drawImage(img,x+(w-dw)/2,y+(h-dh)/2,dw,dh);ctx.restore()
  })
 }
 paragraph(value,size=14,color=WHITE,x=35,width=this.width-70){const h=this.text(value,x,this.y,width,size,color);this.y+=h+8;return h}
 heading(data){this.y+=10;this.y+=this.text(data.title||'荷花插件',35,this.y,this.width-70,36,WHITE,{font:TITLE,leading:42,shadow:true});if(data.subtitle)this.y+=this.text(data.subtitle,35,this.y+3,this.width-70,16,WHITE,{shadow:true})+6;this.y+=14}
 log(title,rows,lead=''){
  const top=this.y,w=this.width-25,x=10
  const titleH=this.lines(title,w-40,20).length*28+16
  const contents=[lead,...rows.map(row=>typeof row==='string'?row:`${row.label||row.title||''}：${row.value??row.body??''}`)].filter(Boolean)
  const heights=contents.map(value=>this.lines(value,w-65,14).length*22+8)
  const h=titleH+heights.reduce((a,b)=>a+b,0)+20
  this.rect(x,top,w,h,'rgba(0,0,0,.50)',10)
  this.rect(x,top,w,titleH,'rgba(0,0,0,.40)',10)
  this.text(title,x+20,top+10,w-40,20,GOLD,{leading:28})
  let y=top+titleH+10
  contents.forEach((value,i)=>{this.text('•',x+20,y,15,14,WHITE);this.text(value,x+40,y,w-65,14,WHITE,{leading:22});y+=heights[i]})
  this.y+=h+10
 }
 async render(template,data,options){
  const height=Math.max(240,this.y+50),displayScale=720/this.width
  this.height=height
  const wanted=Number(options.renderScale??data.renderScale??process.env.LOTUS_RENDER_SCALE??4)
  const scale=Number.isFinite(wanted)?Math.min(4,Math.max(1,wanted)):4
  this.canvas.width=Math.round(this.width*displayScale*scale);this.canvas.height=Math.ceil(height*displayScale*scale)
  const ctx=this.ctx;ctx.scale(displayScale*scale,displayScale*scale);ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality='high'
  const images=new Map()
  await Promise.all([...this.refs].map(async src=>images.set(src,await getImage(src))))
  for(const draw of this.commands)draw(ctx,images)
  const {buffer,tiles,format}=await encodeGpuCanvas(this.canvas,options)
  options.onRender?.({gpu:this.canvas.gpu,...this.canvas.engine,width:this.canvas.width,height:this.canvas.height,tiles,format,template,source:SOURCE_CARD_TEMPLATES[template],missingImages:[...images].filter(([,img])=>!img).map(([src])=>src)})
  if(options.path)await fs.writeFile(options.path,buffer)
  return globalThis.segment?.image?globalThis.segment.image(buffer):buffer
 }
}
function elemental(p){p.rect(0,0,p.width,100000,'#243344');p.commands.push((ctx,images)=>{const img=images.get(path.join(resourcesPath,'miao-theme/bg/bg-hydro.webp'));if(img)ctx.drawImage(img,0,0,p.width,p.height)});p.refs.add(path.join(resourcesPath,'miao-theme/bg/bg-hydro.webp'))}
function table(p,headers,rows,widths){
 const x=10,w=p.width-25
 widths ||= headers.map(()=>w/headers.length)
 let y=p.y
 const entries=[headers,...rows].map(cells=>({cells,h:Math.max(36,...cells.map((cell,i)=>p.lines(cell?.label??cell,widths[i]-12-(cell?.image?36:0),14).length*21+14))}))
 p.clip(x,y,w,entries.reduce((sum,row)=>sum+row.h,0),10)
 const paint=({cells,h},head,index)=>{
  p.rect(x,y,w,h,head?'rgba(0,0,0,.5)':index%2?'#fff':'#f0f0f0')
  let xx=x
  cells.forEach((cell,i)=>{if(cell?.image)p.image(cell.image,xx+3,y+3,30,30);const indent=cell?.image?36:0;p.text(cell?.label??cell,xx+6+indent,y+7,widths[i]-12-indent,14,head?GOLD:'#333',{leading:21});p.rule(xx,y,widths[i],'rgba(100,100,100,.3)');p.rect(xx,y,1,h,'rgba(100,100,100,.3)');xx+=widths[i]})
  y+=h
 }
 entries.forEach((row,i)=>paint(row,i===0,i-1));p.restore();p.y=y+14
}

function profile(p,data){
 elemental(p)
 p.heading({...data,title:data.title||'账号资料卡'})
 const groups=data.roleGroups?.length?data.roleGroups:data.roles?.map(role=>({label:role.label,rows:[{name:role.value}]}))||[]
 for(const group of groups){
  const top=p.y,x=10,w=p.width-25
  const rows=group.rows?.length?group.rows:[{name:'未同步游戏角色'}]
  const h=42+rows.length*76
  p.rect(x,top,w,h,'rgba(255,255,255,.65)',10);p.rect(x,top,w,34,'rgba(255,255,255,.8)',10)
  p.text(group.label,x+15,top+8,w-30,16,'#333')
  rows.forEach((row,i)=>{
   const y=top+42+i*76
   p.rect(x+9,y+20,18,22,row.active?GOLD:WHITE,6);p.text(i+1,x+9,y+23,18,14,'#3a2702',{align:'center'})
   p.rect(x+32,y,w-43,64,'#f0ece4',33)
   if(row.banner)p.image(row.banner,x+32,y,w-43,64,{cover:true,radius:33})
   if(row.image){p.rect(x+36,y+4,56,56,'#fff',30);p.image(row.image,x+38,y+6,52,52,{cover:true,radius:30})}
   const xx=x+(row.image?104:48)
   p.text(row.uid||row.name,xx,y+9,w-(xx-x)-22,row.uid?24:16,INK,{font:row.uid?NUMBER:TEXT,leading:21})
   if(row.uid)p.text([row.name,row.level?`Lv.${row.level}`:'',row.active?'当前 UID':''].filter(Boolean).join(' · '),xx,y+38,w-(xx-x)-22,12,INK)
  });p.y+=h+10
 }
 p.log('账号状态',data.account||[],data.summary)
 p.log('签到设置',data.settings||[])
 if(data.warnings?.length)p.log('提示',data.warnings)
}
function primaryNote(item){
 const d=item.data||{}
 const pair=(a,b)=>a!==undefined?`${a}/${b??'未记录'}`:''
 if(item.game==='gs')return{label:'原粹树脂',value:pair(d.current_resin,d.max_resin),icon:'树脂'}
 if(item.game==='sr')return{label:'开拓力',value:pair(d.current_stamina,d.max_stamina),icon:''}
 if(item.game==='zzz'){const e=d.energy?.progress||d.energy||{};return{label:'电量',value:pair(e.current,e.max),icon:''}}
 return{label:item.gameName||'体力',value:'',icon:''}
}
function daily(p,data){
 // Exact daily-note source: beige canvas, gold title marker, bordered rows,
 // icon/name/time left and a distinct 96px value column on the right.
 p.rect(0,0,p.width,100000,'#f0eae3');p.y=12
 for(const group of data.groups||[]){
  for(const item of group.items||[]){
   p.rect(16,p.y-3,5,24,'#d3bc8d',1)
   const title=`${group.name} · ${item.gameName||item.game} · UID ${item.uid||'未同步'}`
   p.y+=p.text(title,26,p.y,p.width-42,16,'#504c49',{font:NUMBER,singleLine:true,minSize:12})+9
   const primary=primaryNote(item)
   const coin=item.game==='gs'&&item.data?.current_home_coin!==undefined?[{label:'洞天宝钱',value:`${item.data.current_home_coin}/${item.data.max_home_coin}`,icon:'洞天宝钱'}]:[]
   const recovery=(item.detail||'').split(' · ').find(part=>/^(回满|已回满)/.test(part))||''
   const rows=item.ok?[{label:primary.label,value:primary.value||'查询成功',note:primary.value?recovery:item.detail,icon:primary.icon},...coin,...(item.details||[]).map(row=>({...row,icon:{'洞天宝钱':'洞天宝钱','每日委托':'委托','探索派遣':'派遣','最快派遣':'派遣','周本减半':'周本','参量质变仪':'参量质变仪'}[row.label]}))]:[{label:'查询失败',value:'失败',note:item.error||item.detail}]
   for(const row of rows){
    const valueWidth=148,x=16,w=p.width-32,labelWidth=w-valueWidth-53
    const noteLines=row.note?p.lines(row.note,labelWidth,12):[]
    let valueSize=16;p.ctx.font=`${valueSize}px ${NUMBER}`
    while(p.ctx.measureText(String(row.value??'')).width>valueWidth-12&&valueSize>12){valueSize-=.5;p.ctx.font=`${valueSize}px ${NUMBER}`}
    const h=Math.max(49,28+noteLines.length*17+9)
    p.rect(x,p.y,w,h,'#dfd8d1',9);p.clip(x+1,p.y+1,w-2,h-2,8)
    p.rect(x+1,p.y+1,w-valueWidth-1,h-2,'#f5f1eb');p.rect(x+w-valueWidth,p.y+1,valueWidth-1,h-2,'#ece3d8')
    if(row.icon){const icon=path.join(ROOT,'genshin/note-icons/gs',`${row.icon}.png`);if(existsSync(icon))p.image(icon,x+8,p.y+11,25,25)}
    p.text(row.label,x+42,p.y+7,labelWidth,14,'#1e1f20',{font:NUMBER,leading:18})
    if(row.note)p.text(row.note,x+42,p.y+27,labelWidth,12,'#5f5f5d',{font:NUMBER,leading:17})
    p.text(row.value??'',x+w-valueWidth+6,p.y+(h-22)/2,valueWidth-12,valueSize,'#504c49',{font:NUMBER,align:'center',leading:22,singleLine:true,minSize:10});p.restore();p.y+=h+5
   }
   p.y+=16
  }
 }
}
function checkin(p,data){
 elemental(p);p.heading({...data,title:'签到结果',subtitle:[data.title,data.subtitle].filter(Boolean).join(' · ')})
 table(p,['游戏 / 社区','游戏签到','社区签到'],(data.games||[]).map(row=>[row.label,row.game||'未执行',row.community||'未执行']),[160,207.5,207.5])
 if(data.message)p.log(data.badge||'签到结果',[],data.message)
}
function logs(p,data){
 elemental(p)
 p.log(data.title||'荷花插件',data.items||[],[data.subtitle,data.message].filter(Boolean).join('\n'))
}
function qr(p,data){
 p.rect(0,0,p.width,100000,'#243344')
 p.image(path.join(ROOT,'miao/common/theme/bg-01.jpg'),0,0,p.width,1200,{cover:true})
 p.image(path.join(ROOT,'miao/common/theme/main-01.png'),0,0,p.width,800)
 const title=data.title||'扫码登录',subtitle=data.subtitle||`profile ${data.profileId||1}`
 const headerHeight=p.lines(title,p.width-70,50,TITLE).length*60+p.lines(subtitle,p.width-70,16).length*24+38
 p.rect(15,38,p.width-30,headerHeight,'rgba(15,20,31,.78)',15)
 p.y=54;p.y+=p.text(title,35,p.y,p.width-70,50,WHITE,{font:TITLE,leading:60,shadow:true})
 p.y+=p.text(data.subtitle||`profile ${data.profileId||1}`,35,p.y+5,p.width-70,16,WHITE,{shadow:true})+25
 const top=p.y,w=p.width-30,qrSize=360,notice=data.notice||'请使用对应 App 扫码确认。'
 const noticeHeight=p.lines(notice,w-40,16).length*24
 p.rect(15,top,w,qrSize+noticeHeight+98,'rgba(0,0,0,.50)',15)
 p.rect(15,top,w,48,'rgba(0,0,0,.40)',15);p.text('扫码确认',35,top+15,w-40,18,GOLD)
 p.rect((p.width-qrSize)/2-12,top+60,qrSize+24,qrSize+24,'#fff',5)
 p.image(data.qrDataUrl,(p.width-qrSize)/2,top+72,qrSize,qrSize)
 p.text(notice,35,top+qrSize+90,w-40,16,WHITE,{leading:24});p.y=top+qrSize+noticeHeight+113
}

function statBackground(p,sr=false){
 p.rect(0,0,p.width,100000,sr?'#26142a':'#e8e7e4')
 const background=path.join(ROOT,`miao/character/imgs/bg-0${sr?2:1}.jpg`)
 p.refs.add(background)
 p.commands.push((ctx,images)=>{
  const img=images.get(background);if(!img)return
  // Match profile-stat's CSS: background-size: 100% auto; left center; repeat.
  const tileHeight=p.width*img.height/img.width,origin=(p.height-tileHeight)/2
  const first=origin-Math.ceil(origin/tileHeight)*tileHeight
  for(let y=first;y<p.height;y+=tileHeight)ctx.drawImage(img,0,y,p.width,tileHeight)
 })
 p.image(path.join(ROOT,`miao/character/imgs/main-0${sr?2:1}.png`),0,-25,p.width,900)
}
function summaries(p,rows){if(rows?.length)table(p,rows.map(r=>r.label),[rows.map(r=>r.value)])}
const damageNumber=n=>Number(n||0).toLocaleString('zh-CN',{maximumFractionDigits:1})
function team(p,data){
 statBackground(p,data.badge==='SR');p.heading(data);summaries(p,data.summary)
 const members=data.team||[]
 // profile-stat's avatar / level / constellation / weapon cells, enlarged only
 // to accommodate complete names and both games' actual panel attributes.
 table(p,['#','角色','等级 / 命座','装备'],members.map((m,i)=>[i+1,{label:m.name,image:m.icon},`Lv.${m.level??'未记录'} · ${m.cons??m.rank??0}${data.badge==='SR'?'魂':'命'}`,`${m.weapon||'未装配'}\nLv.${m.weaponLevel||'未记录'} · ${m.weaponAffix??m.weaponRank??'未记录'}${data.badge==='SR'?'叠影':'精炼'}`]),[28,160,100,p.width-313])
 const keys=[...new Set(members.flatMap(m=>Object.keys(m.stats||{})))]
 const percentKeys=new Set(['暴击率','暴击伤害','元素充能效率','充能效率','击破','击破特攻','效果命中','效果抵抗'])
 const statValue=(member,key)=>{const value=member.stats?.[key];return value===undefined||value===null?'未记录':percentKeys.has(key)&&/^[-+]?\d+(?:\.\d+)?$/.test(String(value))?`${value}%`:value}
 if(keys.length)table(p,['面板属性',...members.map(m=>m.name)],keys.map(key=>[key,...members.map(m=>statValue(m,key))]),[110,...members.map(()=>(p.width-135)/Math.max(1,members.length))])
 if(members.some(m=>m.panelSource))table(p,['角色','面板来源'],members.map(m=>[m.name,m.panelSource||'未记录']))
 const total=(data.pie||[]).reduce((sum,r)=>sum+Number(r.damage||0),0)
 if(data.pie?.length)table(p,['伤害贡献','伤害','占比'],data.pie.map(r=>[r.char,damageNumber(r.damage),`${total?(Number(r.damage||0)/total*100).toFixed(1):'0'}%`]))
 if(data.actions?.length)p.log('输出手法',[],data.actions.join(' → '))
 if(data.actionTrack?.length)p.log('起手顺序',[],data.actionTrack.slice(0,4).map(r=>r.name).join(' → '))
 if(data.badge==='SR'&&data.detail&&data.battleRecords?.length)table(p,['顺序','关键行动（前 8 项）','行动值'],data.battleRecords.slice(0,8).map(r=>[r.order,[r.title,(r.lines||[]).find(line=>line.type==='skill')?.text].filter(Boolean).join('\n'),r.actionPoint??'未记录']),[50,p.width-165,90])
 if(data.detail){
  if(data.damages?.length)table(p,['时间','动作','伤害'],data.damages.map(r=>[`${r.time??0}s`,r.action,(r.values||[]).join(' / ')]),[65,185,p.width-275])
  if(data.buffs?.length)table(p,['时间','增益','说明'],data.buffs.map(r=>[`${r.time??0}s`,r.name,r.detail]),[65,185,p.width-275])
  if(data.badge!=='SR'&&!data.battleRecords?.length&&data.damageLogs?.length)p.log('伤害过程',data.damageLogs.map(r=>`${r.order} · ${r.text}`))
 }
 if(data.source)p.footerNotes=[`数据来源：${data.source}`]
}
function achievements(p,data){
 statBackground(p);p.heading(data);summaries(p,data.summary)
 if(data.categories?.length)table(p,['分类','已完成','原石','完成率'],data.categories.map(c=>[{label:c.name,image:c.icon},`${c.completed}/${c.total}`,`${c.pointsDone}/${c.pointsTotal}`,`${c.percent}%`]),[270,100,105,p.width-500])
 for(const group of data.groups||[]){
  const title=`${group.name} · ${group.completed}/${group.total} · 原石 ${group.pointsDone}/${group.pointsTotal}`
  const top=p.y,w=p.width-25,lines=p.lines(title,w-40,18)
  const h=lines.length*26+20
  p.rect(10,top,w,h,'rgba(0,0,0,.5)',10);p.text(title,30,top+10,w-40,18,GOLD,{leading:26});p.y+=h
  if(group.desc)p.log('说明',[group.desc])
  table(p,['阶段 / 状态','成就说明','原石 / 进度'],(group.stages||[]).map(s=>[`${s.stageTotal>1?`${s.stageIndex}/${s.stageTotal}`:'单项'} · ${s.done?'已完成':'未完成'}${s.date?'\n'+s.date:''}`,s.desc||s.name,`${s.points} 原石\n${s.progress||'未记录'}`]),[120,p.width-240,95])
 }
 if(data.message)p.log('说明',[data.message])
 if(data.hiddenCount)p.log('下一页',[`还有 ${data.hiddenCount} 个分组，请使用下一页指令继续查看。`])
}
function rank(p,data){
 elemental(p);p.heading(data)
 if(!data.list?.length){p.log('群排名',['群成员尚未保存该代理人的面板。']);return}
 for(const [i,row]of data.list.entries()){
  const x=10,y=p.y,w=p.width-25
  // rank-profile-list's single horizontal strip: rank, circular face, name/UID,
  // six talent badges, weapon, score. More height only when names need wrapping.
  const skills=['普攻','闪避','支援','特殊','连携','核心'].map((name,j)=>({name,level:row.skills?.[[0,2,5,1,3,4][j]]?.level??'未记录'}))
  const titleLines=p.lines(row.name||data.character,110,18)
  const h=Math.max(74,28+titleLines.length*24)
  p.rect(x,y,w,h,'rgba(0,0,0,.5)',10)
  p.text(i+1,x+3,y+24,32,18,GOLD,{align:'center'})
  p.image(row.icon,x+43,y+10,50,50,{cover:true,radius:25})
  p.text(row.name||data.character,x+103,y+8,110,18,GOLD,{leading:24})
  p.text(`${row.uid} · ${row.rank??0}影`,x+103,y+10+titleLines.length*24,110,12,WHITE)
  const skillX=x+224,skillW=37
  skills.forEach((s,j)=>{const xx=skillX+j*skillW;p.text(s.name,xx,y+10,skillW,11,WHITE,{align:'center'});p.rect(xx+5,y+33,27,21,'#fff',5);p.text(s.level,xx+5,y+37,27,12,'#000',{align:'center'})})
  const weaponX=skillX+6*skillW+12,weaponW=150
  p.rect(weaponX-6,y+8,1,h-16,'rgba(255,255,255,.7)')
  if(row.weapon?.icon)p.image(row.weapon.icon,weaponX,y+16,36,36)
  p.text(row.weapon?.name||'音擎未装配',weaponX+40,y+10,weaponW-42,13,GOLD,{leading:18})
  p.text(row.weapon?`Lv.${row.weapon.level} · ${row.weapon.star}星`:'',weaponX+40,y+47,weaponW-42,12,WHITE)
  const scoreX=weaponX+weaponW+12,scoreW=w-(scoreX-x)-5
  p.rect(scoreX-6,y+8,1,h-16,'rgba(255,255,255,.7)')
  p.text(row.score_label,scoreX,y+12,scoreW,12,'#aaa');p.text(row.score_value,scoreX,y+34,scoreW,18,WHITE,{font:NUMBER})
  p.y+=h+10
 }
}
async function newsImage(p,src){
 if(!src)return
 const img=await getImage(src)
 if(!img){p.image(src,30,p.y,p.width-60,200);p.y+=215;return}
 const w=p.width-60,h=w*img.height/img.width
 p.image(src,30,p.y,w,h,{radius:14});p.y+=h+20
}
function mediaStats(data,template){
 const s=data.stat||{},format=n=>n===undefined?'未记录':damageNumber(n)
 const stats=data.type==='live'?[['直播状态',data.liveStatus],['在线人数',format(data.online)]]:[['点赞',format(s.like)],['评论',format(s.reply)],['收藏',format(s.favorite)],...(template==='bilibili-info'?[['投币',format(s.coin)],['播放',format(s.view)],['弹幕',format(s.danmaku)]]:[['分享',format(s.share)]])]
 return stats.map(([label,value])=>`${label} ${value||'未记录'}`).join('    ')
}
async function news(p,data,template){
 // genshin mysNews content order inside Miao help/index's elemental, rounded
 // group container. Keep the article typography and real cover/media content.
 elemental(p)
 const frame={height:0}
 p.commands.push(ctx=>{ctx.fillStyle='rgba(15,20,31,.78)';ctx.beginPath();ctx.roundRect(15,20,p.width-30,frame.height,15);ctx.fill()})
 p.y=40
 const owner=data.owner||'作者资料未记录'
 if(data.avatar)p.image(data.avatar,35,p.y,90,90,{cover:true,radius:45})
 p.text(owner,data.avatar?143:35,p.y+16,p.width-(data.avatar?178:70),30,GOLD,{leading:50})
 p.text(template==='douyin-article'?`第 ${data.page||1} 页`:data.id||'',data.avatar?143:35,p.y+66,p.width-(data.avatar?178:70),22,'#c2c5cb')
 p.y+=130
 p.rule(30,p.y-5,p.width-60,'rgba(211,188,142,.35)')
 p.y+=p.text(data.title||'作品信息',30,p.y,p.width-60,44,WHITE,{leading:60})+20
 if(template==='douyin-article'){
  for(const block of data.blocks||[]){
   if(block.type==='image')for(const src of block.urls||[])await newsImage(p,src)
   else if(block.text)p.y+=p.text(block.text,30,p.y,p.width-60,22,WHITE,{leading:36})+16
  }
 }else{
  const metadata=[data.type==='live'?'直播':data.type==='gallery'?'图集':data.type==='article'?'文章':'视频',data.duration?`${Math.floor(data.duration/60)}分${Math.floor(data.duration%60)}秒`:'',data.createdAt?new Date(data.createdAt*1000).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'}):'',data.media?.length?`${data.media.length} 个媒体项`:''].filter(Boolean).join(' · ')
  p.y+=p.text(metadata,30,p.y,p.width-60,18,GOLD,{leading:28})+20
  await newsImage(p,data.cover||data.image)
  if(data.desc)p.y+=p.text(data.desc,30,p.y,p.width-60,22,WHITE,{leading:36})+20
  if(data.music?.title)p.y+=p.text(`音乐：${data.music.title} · ${data.music.author||''}`,30,p.y,p.width-60,18,'#c2c5cb')+20
  if(data.collection?.title)p.y+=p.text(`合集：${data.collection.title}`,30,p.y,p.width-60,18,'#c2c5cb')+20
  if(data.sources?.length)p.y+=p.text(`可用视频源：${data.sources.map(source=>[source.quality||'清晰度未记录',source.width&&source.height?`${source.width}×${source.height}`:'',source.codec||''].filter(Boolean).join(' ')).join(' / ')}`,30,p.y,p.width-60,18,'#c2c5cb')+20
  for(const warning of data.warnings||[])p.y+=p.text(warning,30,p.y,p.width-60,18,'#c2c5cb')+16
  p.rule(30,p.y,p.width-60,'rgba(211,188,142,.35)');p.y+=22
  p.y+=p.text(mediaStats(data,template),30,p.y,p.width-60,18,GOLD,{leading:28})+18
 }
 frame.height=p.y-10;p.y+=15
}
function searchResults(p,data){
 p.rect(0,0,p.width,100000,'#f5f6fb');p.y=20
 const titleHeight=p.lines(data.title||'图鉴搜索结果',p.width-110,30).length*36+70
 p.rect(15,p.y,p.width-30,titleHeight,'#fff',15)
 p.image(path.join(ROOT,'genshin/html/mysNews-list/蒙德.png'),15,p.y,p.width-30,titleHeight,{cover:true,radius:15})
 p.text(data.title||'图鉴搜索结果',55,p.y+35,p.width-110,30,'#333',{font:NUMBER,leading:36});p.y+=titleHeight+20
 const rows=data.items||[]
 if(!rows.length){p.rect(15,p.y,p.width-30,90,'#fff',15);p.text(data.message||'没有找到图鉴结果。',35,p.y+24,p.width-70,18,'#666');p.y+=110}
 for(const [i,row]of rows.entries()){
  const y=p.y,w=p.width-30,textWidth=row.image?325:p.width-124
  const titleH=p.lines(row.title,textWidth,22).length*28,descH=p.lines(row.desc||'',textWidth,18).length*30
  const h=Math.max(row.image?166:90,titleH+descH+70)
  p.rect(15,y,w,h,'#fff',15)
  p.text(i+1,35,y+24,40,26,'#333',{font:NUMBER,align:'center'})
  p.text(row.title,89,y+24,textWidth,22,'#333',{leading:28})
  p.text(row.desc||'',89,y+titleH+38,textWidth,18,'#999',{leading:30})
  p.text(row.meta||'',89,y+titleH+descH+49,textWidth,14,'#999')
  if(row.image)p.image(row.image,p.width-277,y+26,242,124,{radius:8})
  if(i<rows.length-1)p.rule(35,y+h-1,p.width-70)
  p.y+=h+8
 }
}

export async function renderSourceCard(template,data={},options={}){
 init()
 const widths={'profile-card':450,'daily-note-summary':480,'checkin-result':600,'qr-login':830,'status':600,'schedule-notice':600,'genshin-team-damage':600,'starrail-team-damage':600,'achievement-index':760,'achievement-category':760,'zzz-rank':820,'douyin-info':900,'douyin-article':900,'bilibili-info':900,'atlas-result':700}
 const p=new SourceCanvas(widths[template]||600)
 const builders={'profile-card':profile,'daily-note-summary':daily,'checkin-result':checkin,'status':logs,'schedule-notice':logs,'qr-login':qr,'genshin-team-damage':team,'starrail-team-damage':team,'achievement-index':achievements,'achievement-category':achievements,'zzz-rank':rank,'douyin-info':news,'douyin-article':news,'bilibili-info':news,'atlas-result':searchResults}
 if(!builders[template])throw new Error(`No source template implementation: ${template}`)
 await builders[template](p,data,template)
 const light=['daily-note-summary','atlas-result'].includes(template)
 const footer=[...(p.footerNotes||[]),`荷花插件${data.generatedAt?' · '+data.generatedAt:''}`]
 p.text(footer.join('\n'),15,p.y+15,p.width-30,12,light?'#597487':WHITE,{align:'center',shadow:!light,leading:18})
 p.y+=(footer.length-1)*18
 return p.render(template,data,options)
}
