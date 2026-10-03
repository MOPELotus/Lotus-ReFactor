import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { syncBackendOutput } from '../services/nanokaAtlas/update.js'

test('复制图鉴失败时保留完整旧缓存，成功后再切换目录', async () => {
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'lotus-sync-')),source=path.join(root,'backend'),target=path.join(root,'atlas')
 try {
  await fs.mkdir(path.join(source,'data'),{recursive:true});await fs.mkdir(path.join(target,'data'),{recursive:true})
  await fs.writeFile(path.join(source,'data','new.json'),'new');await fs.writeFile(path.join(target,'data','old.json'),'old')
  const failFs={...fs,cp:async(from,to)=>{await fs.mkdir(to,{recursive:true});await fs.writeFile(path.join(to,'partial.json'),'partial');throw Error('模拟复制中断')}}
  await assert.rejects(syncBackendOutput({backendRoot:source,dataRoot:target,syncGallery:false,fsImpl:failFs}),/复制中断/)
  assert.equal(await fs.readFile(path.join(target,'data','old.json'),'utf8'),'old')
  assert.deepEqual(await fs.readdir(target),['data'])
  await syncBackendOutput({backendRoot:source,dataRoot:target,syncGallery:false})
  assert.deepEqual(await fs.readdir(path.join(target,'data')),['new.json'])
 } finally {await fs.rm(root,{recursive:true,force:true})}
})
