import test from 'node:test'
import assert from 'node:assert/strict'
import { ZzzProfileQueryBridge } from '../services/pluginBridge/zzzPanel.js'

test('群排名采用 Skia 并保持排序、资产准备和一次图片回复', async () => {
  const sent = [], prepared = []
  const bridge = new ZzzProfileQueryBridge({
    loadPanelClass: async () => class {}, registerProfile: async () => {}, syncDevice: async () => {},
    loadRankModule: async () => ({getUid2QQsMapping:async()=>({'10':['1'],'20':['2']})}),
    loadAvatarModule: async () => ({getPanel: uid => ({name_mi18n:'星见雅',level:60,rank:2,equip_score:Number(uid),skills:[],get_small_basic_assets:async()=>{prepared.push(uid)}})}),
    renderRank: async (template,data) => {
      assert.equal(template,'zzz-rank');assert.deepEqual(data.list.map(r=>r.uid),['20','10'])
      assert.equal(data.list[0].name,'星见雅');assert.equal(prepared.length,2)
      return {type:'image',file:'captured-test-image'}
    },
  })
  const result=await bridge.groupRank({
    e:{group_id:123,user_id:1,group:{getMemberMap:async()=>new Map([['1',{}],['2',{}]])},reply:async payload=>sent.push(payload),runtime:{render(){throw Error('不能走 HTML')}}},
    profile:{account:{game_roles:{zzz:[{uid:'10',region:'prod_gf_cn'}]}}},character:'星见雅',mode:'panel',
  })
  assert.equal(result.ok,true);assert.equal(sent.length,1);assert.deepEqual(result.forwarded,['[图片]'])
})
