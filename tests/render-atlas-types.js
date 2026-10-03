// One complete representative for each non-character atlas type at production scale.
import fs from 'node:fs/promises'
import path from 'node:path'
import assert from 'node:assert/strict'
import {NanokaAtlasService,buildAtlasRenderData} from '../services/nanokaAtlas/service.js'
import {buildAtlasPages,renderAtlasPage} from '../core/render/atlas-pages.js'
import {renderTemplate} from '../core/render/service.js'
const out=path.resolve(process.argv[2] || 'temp/atlas-remaster/type-previews')
await fs.mkdir(out,{recursive:true})
const seen=new Set(),report=[]
for await(const result of new NanokaAtlasService({config:{data_root:path.resolve('temp/atlas-remaster/snapshot')}}).items()) {
 assert.equal(result.ok,true)
 const item=result.results[0],key=`${item.game}/${item.page}`
 if(item.page==='角色'||seen.has(key))continue
 seen.add(key)
 const data=buildAtlasRenderData(result);delete data.item.raw
 const pages=data.template==='atlas-challenge'?[null]:buildAtlasPages(data)
 const files=[],engines=[]
 const onRender=engine=>{assert.equal(engine.gpu,true);assert.equal(engine.renderer,'GPU');assert.match(engine.device,/NVIDIA RTX A4000/);assert.deepEqual(engine.missingImages || [],[]);engines.push(engine)}
 for(const page of pages) {
  const file=`${item.game}-${item.page}-${item.id}-${page?.index || 1}-4x.jpg`.replace(/[\/:]/g,'-')
  if(page)await renderAtlasPage({...data,atlasPage:page},{path:path.join(out,file),onRender})
  else await renderTemplate('atlas-challenge',data,{path:path.join(out,file),onRender})
  files.push(file)
 }
 report.push({game:item.game,type:item.page,title:item.title,files,engines})
 console.log(`${key}: ${files.length} page(s)`)
}
assert.equal(seen.size,26)
await fs.writeFile(path.join(out,'manifest.json'),JSON.stringify(report,null,2))
