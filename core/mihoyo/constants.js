// Version/salt pairs are protocol-specific. BBS CN follows upstream
// Womsxd/MihoyoBBSTools 01be3ba (2026-11-01); Passport and HoYoLAB
// keep their own verified protocol identities rather than borrowing BBS salts.
export const MIHOYO_PROTOCOL = Object.freeze({
  bbsCn: Object.freeze({ version: "2.117.0", salt: "9c7b896d7483e9070b27c55f1959c4d5", webSalt: "4751cb5557bfad5e249e58462c39fb0a", x4Salt: "xV8v4Qu54lUKrEYFZkJhB8cuOh9Asafs", x6Salt: "t0qEgfub6cvueAPgR5m9aQWWVciEer7v", clientType: "2", webClientType: "5" }),
  passport: Object.freeze({ version: "2.102.1", salt: "JwYDpKvLj6MrMqqYU6jTKF17KNO2PXoS", appId: "bll8iq97cem8", clientType: "2", sdkVersion: "1.3.1.2" }),
  hoyolab: Object.freeze({ version: "2.57.1", salt: "okr4obncj8bw5a65hbnn5oo6ixjc3l9w", clientType: "2" }),
})

export const MIHOYO = Object.freeze({
  appVersion: MIHOYO_PROTOCOL.bbsCn.version,
  passApi: "https://passport-api.mihoyo.com",
  webApi: "https://api-takumi.mihoyo.com",
  passSalt: MIHOYO_PROTOCOL.passport.salt,
  saltWeb: MIHOYO_PROTOCOL.bbsCn.webSalt,
  passAppId: MIHOYO_PROTOCOL.passport.appId,
})

export function mihoyoUserAgent(device = {}, overseas = false) {
  const protocol = overseas ? MIHOYO_PROTOCOL.hoyolab : MIHOYO_PROTOCOL.bbsCn
  return `Mozilla/5.0 (Linux; Android ${device.android_version || "12"}; ${device.model || "Lotus"}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36 ${overseas ? "miHoYoBBSOversea" : "miHoYoBBS"}/${protocol.version}`
}

export const GAME_BIZ = Object.freeze({
  gs: "hk4e_cn",
  sr: "hkrpg_cn",
  zzz: "nap_cn",
})
