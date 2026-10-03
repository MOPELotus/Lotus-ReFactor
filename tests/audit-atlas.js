// Explicit all-data hardware audit, never run implicitly by unit-test globs.
import fs from 'node:fs/promises'
import path from 'node:path'
import assert from 'node:assert/strict'
import { NanokaAtlasService, buildAtlasRenderData } from '../services/nanokaAtlas/service.js'
import { buildAtlasPages, renderAtlasPage } from '../core/render/atlas-pages.js'
import { renderWithSkia } from '../core/render/skia.js'
const root = path.resolve(process.argv[2] || 'temp/atlas-remaster/snapshot')
const out = path.resolve(process.argv[3] || 'temp/atlas-remaster/audit')
const render = process.argv.includes('--render')
const selected = process.argv.find(arg => arg.startsWith('--types='))?.slice(8).split(',')
await fs.mkdir(out, {recursive:true})
const service = new NanokaAtlasService({config:{data_root:root,locale:'简体中文'}})
const report = {root, records:0, pages:0, counts:{}, failures:[], markup:[], missingImages:[], sourceGaps:[], samples:{}, maxPages:[], hardware:null}
const log = await fs.open(path.join(out,'records.jsonl'),'w')
const pattern = /<\/?[A-Za-z][^>]+>|Icon_[A-Za-z0-9_]+|\{[^}]+\}|#\d+\[|(?:UI_|Skill_|ART_)[A-Za-z0-9_]+|\[object Object\]/g
function inspect(value, field, item) {
 if(typeof value==='string') { const matches=value.match(pattern);if(matches)report.markup.push({game:item.game,type:item.page,title:item.title,field,matches});return }
 if(Array.isArray(value)){value.forEach((v,i)=>inspect(v,`${field}.${i}`,item));return}
 if(value&&typeof value==='object')for(const[k,v]of Object.entries(value))if(!/^(icon|image|portrait|source|atlasRoot|raw|id|version|file|gameFolder|pageId|originalValue)$/.test(k))inspect(v,`${field}.${k}`,item)
}
for await(const result of service.items()) {
 if(!result.ok){report.failures.push(result);continue}
 const item=result.results[0],key=`${item.game}/${item.page}`
 if(selected && !selected.includes(key))continue
 report.records++;report.counts[key]=(report.counts[key]||0)+1
 let pages=[]
 try {
  const data=buildAtlasRenderData(result)
  const gaps = []
  if(item.page==='角色' && !item.image)gaps.push('角色图片源缺失，未使用问号占位图')
  for(const part of item.view?.parts || [])if(!part.icon)gaps.push(`部件图片源缺失：${part.name}`)
  const missingMonsters = new Set()
  const inspectMonsters = value => {
   if(!value || typeof value !== 'object')return
   if(value.imageMissing && value.name)missingMonsters.add(value.name)
   for(const child of Object.values(value))if(typeof child === 'object')inspectMonsters(child)
  }
  inspectMonsters(item.view)
  for(const name of missingMonsters)gaps.push(`敌人图片源缺失：${name}`)
  if(JSON.stringify(item.raw?.content).includes('series_ref_skill_desc'))gaps.push('源数据含动态关联技能说明，当前显示可读提示')
  if(gaps.length)report.sourceGaps.push({game:item.game,type:item.page,title:item.title,gaps})
  delete data.item.raw
  inspect({title:item.title,description:item.description,view:item.view,facts:item.facts,sections:item.sections},'',item)
  pages=data.template==='atlas-challenge'?[null]:buildAtlasPages(data)
  report.maxPages.push({title:item.title,game:item.game,type:item.page,pages:pages.length})
  const saveSample=!report.samples[key] || item.page==='角色'&&['神里绫华','流萤','星见雅'].includes(item.title)
  const filename=`${item.game}-${item.page}-${item.id}`.replace(/[\\/:]/g,'-')
  let saved=[]
  for(const page of pages) {
   report.pages++
   if(!render)continue
   const onRender=engine=>{
    assert.equal(engine.gpu,true);assert.equal(engine.renderer,'GPU');assert.match(engine.device,/NVIDIA RTX A4000/);assert.doesNotMatch(JSON.stringify(engine),/llvmpipe|lavapipe|SwiftShader/i)
    report.hardware ||= engine
    if(engine.missingImages?.length)report.missingImages.push({title:item.title,game:item.game,type:item.page,page:page?.index,images:engine.missingImages})
   }
   const file=saveSample?path.join(out,`${filename}-${page?.index||1}.jpg`):undefined
   if(page) await renderAtlasPage({...data,atlasPage:page},{renderScale:1,path:file,onRender})
   else await renderWithSkia('atlas-challenge',{...data,bg:path.resolve('resources/starrail-abyss/floor12.png')},{renderScale:1,path:file,onRender})
   if(file)saved.push(path.basename(file))
  }
  if(saveSample)report.samples[key]={title:item.title,files:saved}
  await log.write(JSON.stringify({game:item.game,type:item.page,id:item.id,title:item.title,pages:pages.length,ok:true})+'\n')
 } catch(error){report.failures.push({game:item.game,type:item.page,title:item.title,id:item.id,error:error.message});await log.write(JSON.stringify({game:item.game,type:item.page,title:item.title,ok:false,error:error.message})+'\n')}
 if(report.records%100===0){console.log(JSON.stringify({records:report.records,pages:report.pages,failures:report.failures.length,markup:report.markup.length,missing:report.missingImages.length}));await fs.writeFile(path.join(out,'progress.json'),JSON.stringify({records:report.records,pages:report.pages,counts:report.counts,failures:report.failures,markup:report.markup,missing:report.missingImages.length},null,2))}
}
await log.close()
report.maxPages=report.maxPages.sort((a,b)=>b.pages-a.pages).slice(0,25)
await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2))
console.log(JSON.stringify({records:report.records,pages:report.pages,types:Object.keys(report.counts).length,failures:report.failures.length,markup:report.markup.length,missing:report.missingImages.length,hardware:report.hardware}))
process.exitCode=report.failures.length||report.markup.length?1:0
