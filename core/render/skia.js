import fs from 'node:fs/promises'
import {renderStarRailAbyss} from './starrail-abyss.js'
import {renderAtlasPage} from './atlas-pages.js'
import {renderSourceCard,SOURCE_CARD_TEMPLATES} from './source-cards.js'

// Every registered card enters an implementation adapted from an identified
// Yunzai / genshin / Miao source. The former Lotus renderer is removed entirely.
export async function renderWithSkia(templateName,data={},options={}){
 const normalized={pluginName:'荷花插件',...data}
 if(templateName==='atlas-page'||['atlas-item','atlas-challenge'].includes(templateName)){
  return renderAtlasPage({...normalized,template:templateName,view:normalized.view||{
   game:normalized.item?.game||'',page:normalized.item?.page||'图鉴资料',description:normalized.message||'',
  }},options)
 }
 if(templateName==='starrail-challenge'){
  const buffer=await renderStarRailAbyss(normalized,options)
  if(options.path)await fs.writeFile(options.path,buffer)
  return globalThis.segment?.image?globalThis.segment.image(buffer):buffer
 }
 if(SOURCE_CARD_TEMPLATES[templateName])return renderSourceCard(templateName,normalized,options)
 throw new Error(`未注册来源模板：${templateName}`)
}
