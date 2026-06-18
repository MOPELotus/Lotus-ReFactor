import {
  ensureProfile,
  loadProfile,
  saveProfile,
} from "../config/profile.js"

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export class DeviceService {
  constructor(options = {}) {
    this.fetch = options.fetch || globalThis.fetch
  }

  async bindDevice({ qq, profileId = 1, input, nickname = "" } = {}) {
    const profile = await ensureProfile({ qq, profileId, nickname })
    const device = await this.normalizeDevice(input)

    profile.device = {
      ...profile.device,
      bound: true,
      name: device.name || profile.device?.name || "",
      model: device.model || profile.device?.model || "",
      id: device.device_id,
      fp: device.device_fp,
      android_version: device.android_version || profile.device?.android_version || "",
      raw: device.raw,
      updated_at: new Date().toISOString(),
    }

    await saveProfile(profile)
    return profile
  }

  async getDevice(qq, profileId = 1) {
    const profile = await loadProfile(qq, profileId)
    return profile.device || {}
  }

  headersFromProfile(profile) {
    return deviceHeaders(profile?.device)
  }

  async normalizeDevice(input) {
    const info = parseDeviceInput(input)
    const quick = extractDeviceIdAndFp(info)
    if (quick.device_fp) {
      return {
        device_id: quick.device_id || "",
        device_fp: quick.device_fp,
        name: info.deviceName || info.name || "",
        model: info.deviceModel || info.model || "",
        android_version: info.android_version || info.osVersion || "",
        raw: sanitizeDeviceRaw(info),
      }
    }

    if (isFullAndroidDeviceInfo(info)) {
      const generated = await this.requestDeviceFp(info)
      return {
        device_id: generated.device_id,
        device_fp: generated.device_fp,
        name: info.deviceName,
        model: info.deviceModel,
        android_version: info.osVersion || "",
        raw: sanitizeDeviceRaw(info),
      }
    }

    throw new Error("设备信息格式错误，需要 device_fp 或完整 Android 设备信息")
  }

  async requestDeviceFp(info) {
    if (!this.fetch) throw new Error("fetch is unavailable")
    if (String(info.oaid || "").startsWith("error_")) {
      throw new Error(`设备 oaid 异常：${info.oaid}`)
    }
    if (UUID_V4_RE.test(String(info.oaid || ""))) {
      logger?.warn?.("[Lotus-Plugin] device oaid looks like UUID v4; it may be invalid")
    }

    const deviceId = randomHex(16)
    const deviceGuid = guid()
    const brand = String(info.deviceFingerprint || "").split("/")[0] || info.deviceBrand || "Android"
    const response = await this.fetch("https://public-data-api.mihoyo.com/device-fp/api/getFp", {
      method: "POST",
      headers: {
        Host: "public-data-api.mihoyo.com",
        "User-Agent": "okhttp/4.9.3",
      },
      body: JSON.stringify({
        app_name: "bbs_cn",
        bbs_device_id: deviceGuid,
        device_fp: "38d80737ce6f3",
        device_id: deviceId,
        ext_fields: JSON.stringify(buildExtFields(info, brand, deviceGuid)),
        platform: "2",
        seed_id: guid(),
        seed_time: String(Date.now()),
      }),
    })
    if (!response.ok) throw new Error(`获取 device_fp 失败：HTTP ${response.status}`)
    const data = await response.json()
    const deviceFp = data?.data?.device_fp || data?.device_fp
    if (!deviceFp) throw new Error(data?.message || "获取 device_fp 失败")
    return {
      device_id: deviceId,
      device_fp: deviceFp,
    }
  }
}

export function parseDeviceInput(input) {
  if (typeof input === "string") {
    const json = input.trim().match(/(\{[\s\S]*\})/)
    if (!json) throw new Error("未找到设备 JSON")
    return JSON.parse(json[1])
  }
  if (!input || typeof input !== "object") throw new Error("设备信息格式错误")
  return input
}

export function extractDeviceIdAndFp(info = {}) {
  const data = info.data && typeof info.data === "object" ? info.data : info
  return {
    device_id: data.device_id || data.bbs_device_id || data.seed_id || "",
    device_fp: data.device_fp || data.fp || "",
  }
}

export function deviceHeaders(device = {}) {
  const headers = {}
  if (device?.fp) headers["x-rpc-device_fp"] = device.fp
  if (device?.id) headers["x-rpc-device_id"] = device.id
  return headers
}

function isFullAndroidDeviceInfo(info = {}) {
  return Boolean(
    info.deviceName &&
    info.deviceModel &&
    info.oaid &&
    info.deviceFingerprint &&
    info.deviceProduct &&
    info.deviceBoard,
  )
}

function sanitizeDeviceRaw(info = {}) {
  const copy = { ...info }
  delete copy.cookie
  delete copy.stoken
  return copy
}

function buildExtFields(info, brand, deviceGuid) {
  return {
    proxyStatus: 1,
    isRoot: 0,
    romCapacity: "512",
    deviceName: info.deviceName,
    productName: info.deviceModel,
    romRemain: "434",
    hostname: "a11-gz02-test.i.nease.net",
    screenSize: info.screenSize || "1440x2560",
    isTablet: 0,
    aaid: deviceGuid,
    model: info.deviceModel,
    brand,
    hardware: brand,
    deviceType: info.deviceName,
    devId: "REL",
    serialNumber: "unknown",
    sdCapacity: 127991,
    buildTime: info.buildTime || "1731038709000",
    buildUser: "builder001",
    simState: 5,
    ramRemain: "125933",
    appUpdateTimeDiff: 1741848587885,
    deviceInfo: info.deviceFingerprint,
    vaid: guid(),
    buildType: "user",
    sdkVersion: info.sdkVersion || "32",
    ui_mode: "UI_MODE_TYPE_NORMAL",
    isMockLocation: 0,
    cpuType: "arm64-v8a",
    isAirMode: 0,
    ringMode: 2,
    chargeStatus: 1,
    manufacturer: brand,
    emulatorStatus: 0,
    appMemory: "512",
    osVersion: info.osVersion || "12",
    vendor: "unknown",
    accelerometer: "0.10001241x9.800007x0.1999938",
    sdRemain: 119363,
    buildTags: "release-keys",
    packageName: "com.mihoyo.hyperion",
    networkType: "WiFi",
    oaid: info.oaid,
    debugStatus: 0,
    ramCapacity: "127991",
    magnetometer: "15.625x-28.25x-32.625",
    display: info.deviceModel,
    appInstallTimeDiff: 1733055335683,
    packageVersion: "2.35.0",
    gyroscope: "0.0x0.0x0.0",
    batteryStatus: 99,
    hasKeyboard: 1,
    board: info.deviceBoard,
  }
}

function guid() {
  return `${randomHex(8)}-${randomHex(4)}-${randomHex(4)}-${randomHex(4)}-${randomHex(12)}`
}

function randomHex(length) {
  const chars = "0123456789abcdef"
  let result = ""
  for (let i = 0; i < length; i++) {
    result += chars[Math.floor(Math.random() * chars.length)]
  }
  return result
}
