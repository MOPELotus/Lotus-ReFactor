import test from "node:test"
import assert from "node:assert/strict"
import { StarRailChallengeService } from "../services/starRailChallenge/service.js"
import { isStarRailAbyss } from "../core/render/starrail-abyss.js"

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
  assert.equal(isStarRailAbyss({ results: [{ kind: "story" }] }), false)
  assert.equal(isStarRailAbyss({ results: [{ kind: "hall" }, { kind: "boss" }] }), false)
})
