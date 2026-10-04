import test from "node:test"
import assert from "node:assert/strict"
import { StarRailChallengeService } from "../services/starRailChallenge/service.js"
import { isStarRailAbyss, buildStarRailAbyssSections } from "../core/render/starrail-abyss.js"

test("challenge API avatars without names retain IDs and receive character names", async () => {
  const service = new StarRailChallengeService({ fetch: async () => ({
    ok: true,
    json: async () => ({ retcode: 0, data: {
      star_num: 36, extra_star_num: 1,
      all_floor_detail: [{ name: "星启模式", star_num: 4, round_num: 3, is_tierce: true,
        node_1: { avatars: [{ id: 1310, icon: "https://example.com/firefly.png", level: 80, rank: 0, rarity: 5 }] },
        node_2: { avatars: [{ id: 1313, name_mi18n: "接口角色名", level: 80 }] },
        node_3: { avatars: [{ id: 1217, level: 80 }] },
      }],
    } }),
  }) })
  const result = await service.queryProfile({
    profile: { account: { cookie: "test-cookie", game_roles: { sr: [{ uid: "101000001", region: "prod_gf_cn" }] } } },
    profileId: 1, command: "*混沌",
  })
  const floor = result.results[0].floors[0]
  assert.equal(floor.nodes[0].avatars[0].id, 1310)
  assert.equal(floor.nodes[0].avatars[0].name, "流萤")
  assert.equal(floor.nodes[0].avatars[0].rank, 0)
  assert.equal(floor.nodes[1].avatars[0].name, "接口角色名")
  assert.equal(floor.nodes[2].avatars[0].name, "藿藿")
  assert.equal(floor.stars, 4)
  assert.equal(floor.tierce, true)
  assert.equal(result.results[0].extraStars, 1)
  assert.equal(isStarRailAbyss(result.renderData), true)
  assert.equal(isStarRailAbyss({ results: [{ kind: "story" }] }), true)
  assert.equal(isStarRailAbyss({ results: [{ kind: "hall" }, { kind: "boss" }] }), true)
})

test("the four parallel challenge modes use one floor/team model without losing records or zero values", () => {
  const floor = { title: "星启模式", stars: 4, tierce: true, score: 115400, round: 0, nodes: [{ score: 40000, round: 0, buff: "实际增益说明", avatars: [{ name: "流萤" }] }] }
  const knight = { title: "骑士（一）", stars: 3, round: 0, cleared: true, avatars: [{ name: "流萤" }] }
  const record = { title: "落叶归根", bossStars: 3, mobStars: 9, battleNum: 6, boss: { ...knight, title: "堕神之血·亚婆离" }, mobs: [knight, knight, knight] }
  const sections = buildStarRailAbyssSections({ results: [
    ...["hall", "story", "boss"].map(kind => ({ kind, stars: 12, floors: [{ title: "较浅关卡", stars: 3 }, floor] })),
    { kind: "peak", peak: [record, { ...record, title: "上一期" }] },
  ] })
  assert.equal(sections.length, 5)
  assert.deepEqual(sections.slice(0, 3).map(section => section.floorTitle), Array(3).fill("星启模式"))
  assert.equal(sections[1].metrics[0][1], "115400")
  assert.equal(sections[1].metrics[1][1], "0 轮")
  assert.equal(sections[1].nodes[0].buff, "实际增益说明")
  assert.equal(sections[3].stars, 12)
  assert.equal(sections[3].nodes.length, 4)
  assert.equal(sections[3].nodes[0].title, "堕神之血·亚婆离")
  assert.equal(sections[4].floorTitle, "上一期")
  assert.equal(isStarRailAbyss({ results: [{ challengeType: 3 }] }), true)
})
