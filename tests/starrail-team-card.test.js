import test from 'node:test'
import assert from 'node:assert/strict'
import { StarRailTeamDamageService } from '../services/starRailTeamDamage/service.js'

test('默认面板从喵喵资料解析光锥名称，未知 ID 不作为展示文字', async () => {
  const roles=['飞霄','阮梅','知更鸟','加拉赫'].map((name,i)=>({item_id:100+i,nick_name:name,element:'wind',profession:'xunlie',dps_template:{weapon:{id:23016+i}}}))
  const service=new StarRailTeamDamageService({
    engine:{ensureSystemData:async()=>({system_roles:roles}),calculate:async()=>({})},
    loadMiaoModels:async()=>({Player:{create:()=>({getProfiles:()=>({})})},Weapon:{get:(id,game)=>{assert.equal(game,'sr');return id===23016?{name:'烦恼着，幸福着'}:null}}}),
  })
  const result=await service.queryProfile({profile:{account:{game_roles:{sr:[{uid:'101623059'}]}}},command:'*队伍伤害飞霄 阮梅 知更鸟 加拉赫'})
  assert.equal(result.renderData.team[0].weapon,'烦恼着，幸福着')
  assert.equal(result.renderData.team[1].weapon,'光锥资料未记录')
  for(const member of result.renderData.team) assert.doesNotMatch(String(member.weapon),/^\d+$/)
})
