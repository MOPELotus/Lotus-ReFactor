// Temporary launch announcement source; separate from automatic version previews.
// Code/reward: https://www.miyoushe.com/planet/article/79270201
// Expiry and redemption instructions: official poster in article 79269582.
const EXPIRES_AT = Date.parse("2027-01-03T10:00:00+08:00")

export function planetLaunchMessages(now = Date.now()) {
  const expired = now >= EXPIRES_AT
  return {
    expired,
    messages: [
      "《星布谷地》公测前瞻兑换码",
      ...(expired ? ["本次公测兑换码已过期。"] : [
        "XBGD1204",
        "奇物海哨×10",
        "公测开服后可兑换，公测日期：2026年12月4日。",
        "兑换方式：游戏内【设置】—【账号】—【兑换码】，奖励在飞件箱领取。",
      ]),
      "有效期至：2027-01-03 10:00:00 前（北京时间）",
      "官方页面：https://www.miyoushe.com/planet/article/79270201",
      "有效期来源：https://www.miyoushe.com/planet/article/79269582",
    ],
  }
}
