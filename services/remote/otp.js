import fs from "node:fs/promises"
import path from "node:path"
import QRCode from "qrcode"
import YAML from "yaml"
import { resolveData } from "../../core/path.js"
import { buildTotpUri, generateBase32Secret } from "../../core/security/totp.js"

const OTP_FILE = resolveData("remote", "otp.yaml")

export async function loadRemoteOtpSecret(remoteConfig = {}) {
  const envName = remoteConfig.otp_secret_env || "LOTUS_REMOTE_OTP_SECRET"
  const envSecret = process.env[envName]
  if (envSecret) return { ok: true, source: "env", secret: envSecret, envName }

  const stored = await readRemoteOtpConfig()
  if (stored?.secret) return { ok: true, source: "file", secret: stored.secret, config: stored }
  return { ok: false, source: "missing", envName }
}

export async function createRemoteOtpSetup({ userId = "master", issuer = "荷花插件", overwrite = true } = {}) {
  const existing = await readRemoteOtpConfig()
  if (existing?.secret && !overwrite) {
    const uri = buildTotpUri({
      secret: existing.secret,
      issuer: existing.issuer || issuer,
      account: existing.account || `remote-${userId}`,
    })
    return {
      ok: true,
      reused: true,
      config: existing,
      uri,
      qrDataUrl: await QRCode.toDataURL(uri, { errorCorrectionLevel: "M", margin: 1, width: 320 }),
    }
  }

  const config = {
    version: 1,
    issuer,
    account: `remote-${userId || "master"}`,
    secret: generateBase32Secret(20),
    created_at: new Date().toISOString(),
  }
  await fs.mkdir(path.dirname(OTP_FILE), { recursive: true })
  await fs.writeFile(OTP_FILE, YAML.stringify(config), "utf8")
  const uri = buildTotpUri(config)
  return {
    ok: true,
    reused: false,
    config,
    uri,
    qrDataUrl: await QRCode.toDataURL(uri, { errorCorrectionLevel: "M", margin: 1, width: 320 }),
  }
}

export async function remoteOtpStatus(remoteConfig = {}) {
  const loaded = await loadRemoteOtpSecret(remoteConfig)
  if (!loaded.ok) {
    return {
      ok: false,
      source: "missing",
      message: `未配置 2FA secret，请主人执行 #远程2FA初始化，或设置环境变量 ${loaded.envName}。`,
    }
  }
  return {
    ok: true,
    source: loaded.source,
    message: loaded.source === "env"
      ? `已从环境变量 ${loaded.envName} 读取 2FA secret。`
      : `已从 ${OTP_FILE} 读取 2FA secret。`,
    createdAt: loaded.config?.created_at || "",
    account: loaded.config?.account || "",
  }
}

async function readRemoteOtpConfig() {
  try {
    const text = await fs.readFile(OTP_FILE, "utf8")
    return YAML.parse(text) || {}
  } catch (error) {
    if (error?.code === "ENOENT") return null
    throw error
  }
}
