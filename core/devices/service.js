import {
  loadLoggedInProfile,
  loadProfile,
  saveProfile,
  normalizeProfileId,
  withProfileWrite,
  getProfileLifetime,
} from "../config/profile.js"
import { formatLocalIso } from "../time.js"
import { cookieUidValues, parseCookieString } from "../mihoyo/cookies.js"
import { MIHOYO } from "../mihoyo/constants.js"
import { deviceAndroidVersion } from "./metadata.js"
import { withPendingLoginSync, syncCurrentLoginProfile } from "../login/refresh.js"

const deviceOperationsKey = Symbol.for("lotus-plugin.device-binding-operations")
const deviceOperations = globalThis[deviceOperationsKey] ||= new Map()

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export class DeviceService {
  constructor(options = {}) {
    this.fetch = options.fetch || globalThis.fetch
    this.store = options.store || { loadLoggedInProfile, loadProfile, saveProfile }
    this.syncOptions = options.syncOptions || {}
    this.logger = options.logger || globalThis.logger
  }

  async bindDevice({ qq, profileId = 1, input, nickname = "" } = {}) {
    const id = normalizeProfileId(profileId)
    const key = `${String(qq)}:${id}`
    const lifetime = getProfileLifetime(qq, id)
    const operation = Symbol("device binding")
    deviceOperations.set(key, operation)
    const assertCurrent = () => {
      if (deviceOperations.get(key) !== operation) throw new Error("设备绑定已被新的操作取代，请使用最新结果")
      if (getProfileLifetime(qq, id) !== lifetime) throw new Error("设备绑定期间档案已归档，请为当前档案重新绑定")
    }
    try {
      const original = await this.store.loadLoggedInProfile(qq, id)
      const identity = deviceAccountIdentity(original.account)
      const device = await this.normalizeDevice(input)
      const saved = await withProfileWrite(qq, id, async () => {
        assertCurrent()
        // A refresh may have saved new tokens/settings while getFp was running.
        // Never write the pre-request profile or resurrect a logged-out account.
        const latest = await this.store.loadLoggedInProfile(qq, id)
        assertCurrent()
        if (!sameDeviceAccount(identity, deviceAccountIdentity(latest.account))) throw new Error("设备绑定期间账号已更换，请为当前账号重新绑定")
        if (nickname && !latest.user?.nickname) {
          latest.user ||= {}
          latest.user.nickname = nickname
        }
        const previousDevice = latest.device?.id === device.device_id ? latest.device : {}
        latest.device = {
          ...previousDevice,
          bound: true,
          generated: false,
          name: device.name || previousDevice.name || "",
          model: device.model || previousDevice.model || "",
          id: device.device_id,
          fp: device.device_fp,
          android_version: device.android_version || previousDevice.android_version || "",
          raw: device.raw,
          updated_at: formatLocalIso(),
        }
        // Persist intent first so a restart can repair a device-only change,
        // even when its cookie was already synchronized.
        await withPendingLoginSync(qq, id, async () => {
          await this.store.saveProfile(latest)
        }, this.syncOptions)
        return latest
      })
      try {
        const result = await syncCurrentLoginProfile(qq, id, {
          ...this.syncOptions,
          accountService: { get: (user, profileId) => this.store.loadLoggedInProfile(user, profileId) },
          forceSync: true,
        })
        this.lastSyncStatus = { pending: result?.ok === false }
      } catch {
        // The device is saved; retain the durable marker for startup repair.
        this.lastSyncStatus = { pending: true }
        this.logger?.warn?.("[Lotus-Plugin] device saved; cache synchronization pending retry")
      }
      assertCurrent()
      return saved
    } finally {
      if (deviceOperations.get(key) === operation) deviceOperations.delete(key)
    }
  }

  async getDevice(qq, profileId = 1) {
    const profile = await this.store.loadProfile(qq, profileId)
    return profile.device || {}
  }

  headersFromProfile(profile) {
    return deviceHeaders(profile?.device)
  }

  async normalizeDevice(input) {
    const info = parseDeviceInput(input)
    // getFp requests carry a seed in device_fp; failed responses may echo it.
    // Neither is a fingerprint issued by the service.
    if ("ext_fields" in info || ("app_name" in info && "seed_id" in info)) {
      throw new Error("getFp 请求中的 device_fp 只是种子，请提供真机设备信息或成功响应中的设备指纹")
    }
    if (info.data && typeof info.data === "object" && ("retcode" in info || "code" in info.data)) {
      if (info.retcode !== 0 || String(info.data.code) !== "200"
        || typeof info.data.device_fp !== "string" || !/^[0-9a-f]{13}$/i.test(info.data.device_fp)) {
        throw new Error("getFp 响应未成功签发设备指纹，请勿绑定失败响应中回显的种子")
      }
    }
    const quick = extractDeviceIdAndFp(info)
    if (quick.device_fp) {
      if (typeof quick.device_id !== "string" || !quick.device_id.trim()
        || typeof quick.device_fp !== "string" || !quick.device_fp.trim()) {
        throw new Error("设备信息需要同一设备的非空 device_id 和 device_fp，请重新复制完整设备信息")
      }
      return {
        device_id: quick.device_id.trim(),
        device_fp: quick.device_fp.trim(),
        name: info.deviceName || info.name || "",
        model: info.deviceModel || info.model || "",
        android_version: deviceAndroidVersion(info),
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
        android_version: deviceAndroidVersion(info),
        raw: sanitizeDeviceRaw(info),
      }
    }

    throw new Error("设备信息格式错误，需要 device_fp 或完整 Android 设备信息")
  }

  async requestDeviceFp(info, { deviceId: suppliedId, deviceGuid: suppliedGuid } = {}) {
    if (!this.fetch) throw new Error("fetch is unavailable")
    if (UUID_V4_RE.test(String(info.oaid || ""))) {
      this.logger?.warn?.("[Lotus-Plugin] device oaid looks like UUID v4; it may be invalid")
    }
    const payload = buildDeviceFpPayload(info, { deviceId: suppliedId, deviceGuid: suppliedGuid })
    const response = await this.fetch("https://public-data-api.mihoyo.com/device-fp/api/getFp", {
      method: "POST",
      signal: AbortSignal.timeout(20000),
      headers: {
        Host: "public-data-api.mihoyo.com",
        "User-Agent": "okhttp/4.9.3",
      },
      body: JSON.stringify(payload),
    })
    if (!response.ok) throw new Error(`获取 device_fp 失败：HTTP ${response.status}`)
    const data = await response.json()
    const deviceFp = data?.data?.device_fp
    if (data?.retcode !== 0 || String(data?.data?.code) !== "200"
      || typeof deviceFp !== "string" || !/^[0-9a-f]{13}$/i.test(deviceFp)) {
      throw new Error("获取 device_fp 失败：响应未成功签发有效设备指纹")
    }
    return {
      device_id: payload.device_id,
      device_fp: deviceFp,
      bbs_device_id: payload.bbs_device_id,
    }
  }
}

// Shared wire builder: no network, account credentials or profile mutation.
export function buildDeviceFpPayload(info, { deviceId: suppliedId, deviceGuid: suppliedGuid } = {}) {
  if (suppliedId !== undefined && (typeof suppliedId !== "string" || !/^(?:[0-9a-f]{16}|[0-9a-f]{32})$/i.test(suppliedId))) throw new Error("设备 ID 格式错误")
  if (suppliedGuid !== undefined && (suppliedId === undefined || typeof suppliedGuid !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(suppliedGuid))) throw new Error("设备 GUID 格式错误")
  if (String(info.oaid || "").startsWith("error_")) {
    throw new Error(`设备 oaid 异常：${info.oaid}`)
  }
  const deviceId = suppliedId ?? randomHex(16)
  const deviceGuid = suppliedGuid ?? guid()
  const brand = String(info.deviceFingerprint || "").split("/")[0] || info.deviceBrand || "Android"
  return {
    app_name: "bbs_cn",
    bbs_device_id: deviceGuid,
    device_fp: "38d80737ce6f3",
    device_id: deviceId,
    ext_fields: JSON.stringify(buildExtFields(info, brand, deviceGuid)),
    platform: "2",
    seed_id: guid(),
    seed_time: String(Date.now()),
  }
}

function deviceAccountIdentity(account = {}) {
  const ids = [...new Set([
    account.stuid, account.ltuid,
    ...cookieUidValues(account.cookie), ...cookieUidValues(account.stoken_cookie),
  ].filter(value => value !== undefined && value !== null && String(value).trim()).map(value => String(value).trim()))]
  if (ids.length > 1) throw new Error("账号身份不一致，请重新登录后绑定设备")
  // Profiles without a UID cannot safely associate a changed credential set
  // with the original account. Keep that case conservative.
  const mids = [...new Set([
    account.mid,
    ...[account.cookie, account.stoken_cookie].flatMap(cookie => {
      const fields = parseCookieString(cookie)
      return [fields.mid, fields.account_mid_v2, fields.ltmid_v2, fields.stmid_v2]
    }),
  ].filter(value => value !== undefined && value !== null && String(value).trim()).map(value => String(value).trim()))]
  if (mids.length > 1) throw new Error("账号 MID 不一致，请重新登录后绑定设备")
  return { uid: ids[0] || "", mid: mids[0] || "", credentials: ids.length ? "" : JSON.stringify([account.cookie || "", account.stoken || account.stoken_cookie || ""]) }
}

function sameDeviceAccount(original, latest) {
  if (original.uid !== latest.uid) return false
  if (original.mid && latest.mid && original.mid !== latest.mid) return false
  return Boolean(original.uid) || original.credentials === latest.credentials
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
    romCapacity: info.romCapacity || "512",
    deviceName: info.deviceName,
    productName: info.deviceProduct || info.deviceModel,
    romRemain: info.romRemain || (info.romCapacity ? undefined : "434"),
    hostname: "a11-gz02-test.i.nease.net",
    screenSize: info.screenSize || "1440x2560",
    isTablet: 0,
    aaid: deviceGuid,
    model: info.deviceModel,
    brand,
    hardware: info.hardware || brand,
    deviceType: info.deviceName,
    devId: "REL",
    serialNumber: "unknown",
    sdCapacity: info.sdCapacity || (info.romCapacity ? undefined : 127991),
    buildTime: info.buildTime || (info.bbsDeviceId ? undefined : "1731038709000"),
    buildUser: info.buildUser || "builder001",
    simState: 5,
    ramRemain: info.ramRemain || (info.ramCapacity ? undefined : "125933"),
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
    manufacturer: info.manufacturer || brand,
    emulatorStatus: 0,
    appMemory: "512",
    osVersion: deviceAndroidVersion(info) || "12",
    vendor: "unknown",
    accelerometer: "0.10001241x9.800007x0.1999938",
    sdRemain: info.sdRemain || (info.romCapacity ? undefined : 119363),
    buildTags: "release-keys",
    packageName: "com.mihoyo.hyperion",
    networkType: "WiFi",
    oaid: info.oaid,
    debugStatus: 0,
    ramCapacity: info.ramCapacity || "127991",
    magnetometer: "15.625x-28.25x-32.625",
    display: info.display || String(info.deviceFingerprint || "").split("/")[3] || info.deviceModel,
    appInstallTimeDiff: 1733055335683,
    packageVersion: info.packageVersion || MIHOYO.appVersion,
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
