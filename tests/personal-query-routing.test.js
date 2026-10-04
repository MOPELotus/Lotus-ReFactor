import test from 'node:test'
import assert from 'node:assert/strict'
import { matchPersonalQuery } from '../core/intercept/personal-query.js'
import { parseAtlasShortcutMessage } from '../services/nanokaAtlas/service.js'

globalThis.plugin = class { constructor(options) { Object.assign(this, options) } }
const { LotusAchievements } = await import('../apps/achievements.js')
const { LotusProfileQuery } = await import('../apps/profileQuery.js')
const { LotusPanelUpdate } = await import('../apps/panelUpdate.js')

const cases = []
function add(prefixes, periods, aliases, method) {
  for (const prefix of prefixes) for (const period of periods) for (const alias of aliases) {
    for (const suffix of ['', '1', ' 2', '255']) cases.push([`${prefix}${period}${alias}${suffix}`, method])
  }
}
add(['#', '#原神'], ['', '本期', '当期'], ['深渊', '深境', '深境螺旋'], 'miaoAbyssSummary')
add(['#', '#原神'], ['', '本期', '当期', '上期'], ['幻想', '幻境', '剧诗', '幻想真境剧诗'], 'miaoRoleCombatSummary')
add(['#', '#原神'], ['', '本期', '当期', '上期'], ['幽境', '危战', '幽境危战', '幽境单人', '危战合作', '幽境危战最佳'], 'miaoHardChallengeSummary')
add(['*', '#星铁'], ['', '本期', '当期', '上期', '往期', '最新'], ['混沌', '混沌回忆', '忘却之庭', '虚构', '虚构叙事', '末日', '末日幻影', '异相', '异相仲裁', '仲裁', '异乡', '异向', '简易深渊'], 'starRailChallenge')
add(['%', '％', '#绝区零', '%zzz', '%绝区零', '#zzz', '#ZZZ', '/绝区零'], ['', '本期', '当期', '上期', '往期'], ['式舆', '式舆防卫', '式舆防卫战', '防卫', '防卫战', '深渊'], 'zzzAbyss')
add(['%', '％', '#绝区零', '%zzz'], ['', '本期', '当期', '上期', '往期'], ['危局', '危局强袭战', '强袭', '强袭战'], 'zzzDeadly')
add(['%', '％', '#绝区零', '%zzz'], ['', '本期', '当期', '上期', '往期'], ['临界', '临界推演', '推演'], 'zzzVoidFrontBattle')
add(['%', '％', '#绝区零', '%zzz'], [''], ['拟真鏖战试炼', '鏖战', '爬塔'], 'zzzClimbingTower')

test(`三游戏 ${cases.length} 个挑战组合进入战绩，成就与图鉴不抢占`, async () => {
  const achievements = new LotusAchievements({ service: { resolveCategory() { throw Error('战绩不应查询成就') } } })
  const personal = new LotusProfileQuery()
  for (const [command, method] of cases) {
    assert.equal(matchPersonalQuery(command)?.fnc, method, command)
    assert.equal(personal.rule.find(rule => new RegExp(rule.reg).test(command))?.fnc, method, command)
    assert.equal(parseAtlasShortcutMessage(command).ok, false, command)
    achievements.e = { msg: command }
    assert.equal(await achievements.category(), false, command)
  }
})

test('上期深渊继续让行上游，显式挑战图鉴、日期和下期资料仍可查询', async () => {
  const app = new LotusAchievements({ service: { resolveCategory() { throw Error('不应查询成就') } } })
  for (const command of ['#上期深渊', '#往期深境', '#上期深境螺旋']) {
    assert.equal(parseAtlasShortcutMessage(command).ok, false, command)
    app.e = { msg: command }; assert.equal(await app.category(), false, command)
  }
  for (const command of ['#本期剧诗图鉴', '#上期幽境图鉴', '*上期末日图鉴', '#星铁本期异相图鉴', '%本期防卫战图鉴', '#图鉴 本期幻想', '#2026-10-04本期幽境', '%下期防卫战']) {
    assert.equal(parseAtlasShortcutMessage(command).ok, true, command)
  }
  for (const command of ['#神里绫华', '*流萤星魂', '%星见雅影画']) assert.equal(parseAtlasShortcutMessage(command).ok, true, command)
  for (const command of ['#剧诗123456789', '%危局123456789', '*末日123456789']) assert.equal(matchPersonalQuery(command), null, command)
})

test('挑战转发保留上期及单人语义，补齐上游认可的绝区零前缀与别名', async () => {
  const received = []
  const app = new LotusProfileQuery({
    miao: { abyssSummary: async options => received.push(options.command), roleCombatSummary: async options => received.push(options.command), hardChallengeSummary: async options => received.push(options.command) },
    zzz: { abyss: async options => received.push(options.command), deadly: async options => received.push(options.command), voidFrontBattle: async options => received.push(options.command) },
  })
  app.runProfileQuery = async ({ runner }) => runner({})
  for (const command of ['#原神上期剧诗2', '#当期幽境单人1', '#当期深渊1', '%当期式舆防卫1', '#绝区零上期危局2', '%zzz本期临界2']) {
    app.e = { msg: command, user_id: 'test' }
    await app[matchPersonalQuery(command).fnc]()
  }
  assert.deepEqual(received, ['#喵喵上期剧诗', '#喵喵本期幽境单人', '#喵喵深渊', '%zzz式舆防卫战', '%zzz上期危局', '%zzz临界'])
})

test('面板、统计、月报和探索等个人入口也统一让行', async () => {
  const app = new LotusAchievements({ service: { resolveCategory() { throw Error('不应查询成就') } } })
  for (const command of ['#角色', '#面板角色2', '#练度统计1', '#角色列表', '#神里绫华面板2', '*流萤面板1', '%星见雅面板2', '#zzz蕾米排名1', '#绝区零练度统计2', '%月报1', '%月报上月', '%探索度1', '%枯萎苗圃2', '%迷失之地1']) {
    assert.ok(matchPersonalQuery(command), command)
    assert.equal(parseAtlasShortcutMessage(command).ok, false, command)
    app.e = { msg: command }; assert.equal(await app.category(), false, command)
  }
})

test('绝区零更新提示先于 profile 读取和上游执行，其他游戏保持回复顺序', async () => {
  const events = []
  const app = new LotusPanelUpdate({
    loadProfile: async () => { events.push('load'); return {} },
    refreshProfile: async () => { events.push('refresh'); return {} },
    panelBridge: () => ({ updatePanel: async () => { events.push('update'); return { forwarded: ['image'], messages: [] } } }),
  })
  app.reply = async message => events.push(message)
  for (const command of ['%更新面板', '％面板更新2', '#绝区零更新面板255', '%zzz更新面板', '%绝区零更新全部面板', '#ZZZ更新面板', '/zzz更新面板2', '绝区零更新面板']) {
    events.length = 0; app.e = { msg: command, user_id: 'test' }
    assert.equal(app.rule.find(rule => new RegExp(rule.reg).test(command))?.fnc, 'zzzPanel')
    assert.equal(matchPersonalQuery(command), null, command)
    await app.zzzPanel()
    assert.match(events[0], /已收到指令.*正在更新绝区零面板/)
    assert.deepEqual(events.slice(1), ['load', 'refresh', 'update'])
  }
  events.length = 0; app.e = { msg: '#更新面板', user_id: 'test' }; await app.genshinPanel()
  assert.deepEqual(events, ['load', 'refresh', 'update'])
})

test('多页成就先提示图片数量，再将完整分页合并转发', async () => {
  const events = [], nodes = []
  const app = new LotusAchievements({
    service: {
      resolveCategory: async query => ({ name: query }),
      buildCategory: async ({ offset, limit }) => ({ renderData: { groups: [offset], page: { index: offset / limit + 1, total: 3, end: offset + limit, hasNext: offset < limit * 2 } } }),
    },
    resolveCategoryUid: async () => '123456789', getCategoryBackgrounds: async () => [],
    renderCategory: async (template, data) => { events.push(`render ${data.page.index}`); return { type: 'image', file: `page-${data.page.index}` } },
  })
  app.e = { msg: '#天地万象', user_id: 'test', group: { makeForwardMsg: async value => { nodes.push(...value); return { type: 'forward' } } } }
  app.reply = async value => events.push(value)
  assert.equal(await app.category(), true)
  assert.match(events[0], /天地万象.*共 3 张.*合并转发/)
  assert.deepEqual(events.slice(1, 4), ['render 1', 'render 2', 'render 3'])
  assert.deepEqual(nodes.map(node => node.message.file), ['page-1', 'page-2', 'page-3'])
  assert.equal(events[4].type, 'forward')
})
