import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { NanokaAtlasService, buildAtlasRenderData, parseAtlasShortcutMessage, cleanText } from '../services/nanokaAtlas/service.js'
import { buildAtlasPages } from '../core/render/atlas-pages.js'
import { plainGameText } from '../core/render/plain-text.js'

test('game markup retains readable controls, link text, numbers and arithmetic', () => {
 assert.equal(cleanText('{LINK#N11330003}<color=#fff>星见雅</color>{/LINK} <Term:1000010>异常</Term>'), '星见雅 异常')
 assert.equal(cleanText('{NICKNAME} {F#少女}{M#少年}'), '开拓者 少女')
 assert.equal(cleanText('{LAYOUT_CONSOLECONTROLLER#操作杆}{LAYOUT_FALLBACK#摇杆}'), '摇杆')
 assert.equal(cleanText('{CAL:2*20*0.8,1,2}'), '32')
 assert.equal(cleanText('<IconMap:Icon_Normal>'), '普通攻击')
 assert.equal(plainGameText('<b>hello</b>&amp;<br>world'), 'hello&\nworld')
 assert.equal(plainGameText('...'), '')
 assert.equal(plainGameText('？？？'), '')
 assert.doesNotMatch(cleanText('{CAL:-50+AvatarSkillLevel(3)*250,1,2}'), /CAL|AvatarSkillLevel/)
 assert.equal(cleanText('{CAL:process.exit(1),1,2}'), '随技能效果变化')
})

test('each complete character category remains on one long image, with skills and talents together', () => {
 const text='技能完整说明。'.repeat(250)
 const levels=Array.from({length:15},(_,i)=>`Lv${i+1}`)
 const data={title:'分页角色',view:{kind:'character',game:'原神',skills:[{title:'长技能',desc:text,tables:[{headers:['倍率',...levels],rows:[{label:'完整倍率',values:levels.map((_,i)=>`${i+1}%`)}]}]}],constellations:Array.from({length:6},(_,i)=>({level:`${i+1}命`,title:`命座${i+1}`,desc:'完整命座说明。'})),passives:[{title:'固有天赋',desc:'天赋完整效果'}],stats:[],meta:[]}}
 const pages=buildAtlasPages(data)
 assert.equal(pages.length,2)
 assert.equal(pages[0].section,'技能与天赋')
 assert.equal(pages[1].section,'命座')
 assert.ok(pages[0].height>1270)
 assert.equal(pages.filter(p=>p.section==='命座').length,1)
 assert.ok(pages[0].blocks.some(b=>b.title?.includes('固有天赋')))
 const bodies=pages.flatMap(p=>p.blocks).filter(b=>b.type==='text').flatMap(b=>b.lines).join('')
 assert.ok(bodies.includes(text))
 const heads=pages.flatMap(p=>p.blocks).filter(b=>b.type==='table-head').flatMap(b=>b.cells.flat())
 for(const level of levels)assert.ok(heads.includes(level))
 const labels=pages.flatMap(p=>p.blocks).filter(b=>b.type==='label').flatMap(b=>b.title).join('')
 for(let i=1;i<=6;i++)assert.ok(labels.includes(`命座${i}`))
 for(const page of pages)assert.notEqual(page.blocks.filter(b=>b.type!=='gap').at(-1)?.type,'label')
})

test('ZZZ internal rarity 2/3/4 becomes B/A/S and known character facts are cross-checked', async () => {
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'lotus-atlas-'))
 try {
  const dir=path.join(root,'data/items/简体中文/绝区零/角色');await fs.mkdir(dir,{recursive:true})
  const character={meta:{gameId:'zzz',pageFolder:'角色',recordId:1011,name:'安比',rarity:'三星',images:[{fieldPath:'icon',localPath:'gallery/_placeholder/unknown.svg',placeholder:true,status:'placeholder'},{fieldPath:'detail.skill.basic.icon',localPath:'gallery/zzz/skill.webp',status:'downloaded'}]},content:{list:{rank:3},detail:{rarity:3,partner_info:{full_name:'错误名字'},element_type:{203:'错误属性'}}}}
  await fs.writeFile(path.join(dir,'anby.json'),JSON.stringify(character))
  await fs.writeFile(path.join(dir,'invalid-rank.json'),JSON.stringify({meta:{gameId:'zzz',pageFolder:'角色',recordId:9999,name:'等级异常记录',images:[]},content:{list:{rank:2},detail:{rarity:2}}}))
  const weapon=path.join(root,'data/items/简体中文/绝区零/音擎');await fs.mkdir(weapon,{recursive:true})
  for(const rarity of [2,3,4])await fs.writeFile(path.join(weapon,`${rarity}.json`),JSON.stringify({meta:{gameId:'zzz',pageFolder:'音擎',recordId:9000+rarity,name:`测试音擎${rarity}`,rarity:`${rarity}星`,images:[]},content:{list:{rank:rarity},detail:{rarity}}}))
  const items=[];for await(const r of new NanokaAtlasService({config:{data_root:root}}).items()){assert.equal(r.ok,true);items.push(r.results[0])}
  const anby=items.find(i=>i.id==='1011')
  assert.equal(anby.title,'安比·德玛拉');assert.equal(anby.rarity,'A级')
  assert.equal(anby.image,'')
  assert.equal(anby.view.meta.find(i=>i.label==='属性').value,'电属性')
  assert.equal(items.find(i=>i.id==='9999').rarity,'资料待核对')
  assert.deepEqual(items.filter(i=>i.page==='音擎').map(i=>i.rarity).sort(),['A级','B级','S级'].sort())
 } finally {await fs.rm(root,{recursive:true,force:true})}
})

test('talent and constellation commands send identical complete books as one forward message', async () => {
 globalThis.plugin ||= class {}
 const {sendAtlasSearchResult}=await import('../apps/atlas.js')
 const result={ok:true,results:[{title:'流萤',game:'星铁',page:'角色',template:'atlas-item',view:{kind:'character',game:'星铁',skills:[{title:'技能'}],constellations:[{title:'星魂'}]}}]}
 const forwarded=[]
 const target={e:{user_id:1,group:{makeForwardMsg:async nodes=>({type:'forward',nodes})},reply:async payload=>{forwarded.push(payload);return true}}}
 const renderBook=async data=>{assert.equal(data.view.skills.length,1);assert.equal(data.view.constellations.length,1);return [{image:{type:'image',data:'skills'},section:'技能详情'},{image:{type:'image',data:'cons'},section:'星魂'}]}
 for(const command of ['*流萤天赋','*流萤星魂']){
  const parsed=parseAtlasShortcutMessage(command);assert.equal(parsed.query,'流萤');await sendAtlasSearchResult(target,result,{renderBook})
 }
 assert.equal(forwarded.length,2)
 assert.deepEqual(forwarded[0],forwarded[1])
 assert.equal(forwarded[0].nodes.length,3)
 assert.match(forwarded[0].nodes[0].message,/技能详情 → 星魂/)
})

test('HSR level matrices keep fixed effects in the full Lv1 description', async () => {
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'lotus-hsr-'))
 try {
  const dir=path.join(root,'data/items/简体中文/星铁/角色');await fs.mkdir(dir,{recursive:true})
  await fs.writeFile(path.join(dir,'role.json'),JSON.stringify({meta:{gameId:'hsr',pageFolder:'角色',recordId:9999,name:'测试角色',images:[]},content:{list:{},detail:{skills:[{name:'完整技能',simple_desc:'造成伤害。',desc:'造成#1[i]%伤害，行动提前25%。',level:{1:{level:1,param_list:[1]},2:{level:2,param_list:[2]}}}]}}}))
  const service=new NanokaAtlasService({config:{data_root:root}})
  const result=(await service.items().next()).value;assert.equal(result.ok,true)
  const skill=result.results[0].view.skills[0]
  assert.match(skill.desc,/25%/);assert.equal(skill.tables[0].headers.length,3)
  assert.deepEqual(skill.levelRows,[])
 } finally {await fs.rm(root,{recursive:true,force:true})}
})
