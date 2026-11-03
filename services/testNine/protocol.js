import crypto from "node:crypto"

// These wire formats were checked against the official click SDKs. A new SDK
// requires checking its payload too, not just replacing the version string.
const CLICK_PROTOCOLS = {
  "3.1.0": "$_FB",
  "3.1.2": "$_FG",
}
const FULLPAGE_PROTOCOLS = {
  // Official SDK SHA-256: 923a147d20ec0a941a44ab815991034fee5af16d5bb59fa23dcc86eb1a8734e1
  // Token generation checked in the original SDK closure in Chromium.
  "9.2.0-guwyxh": { featureCount: 74, captcha_token: "112439067", tsfq: "xovrayel" },
}
const GCT_SCRIPTS = {
  "gct.b71a9027509bc6bcfef9fc6a196424f5.js": {
    sha256: "e97289fbccc2f04027a0b045e754fa2fadac22687a0cf89d57c945f71a508578",
    // Verified against the browser SDK's _gct and numeric postprocessing.
    fields: { h9s9: "1816378497" },
  },
}

export function clickProtocol(resource) {
  const version = String(resource || "").match(/(?:^|\/)click\.(\d+\.\d+\.\d+)\.js(?:\?.*)?$/)?.[1]
  if (!CLICK_PROTOCOLS[version]) throw new Error("本地尚未支持该极验点击协议版本，请使用后续过码方案")
  return { version, touchKey: CLICK_PROTOCOLS[version] }
}

export function fullpageProtocol(resource) {
  const version = String(resource || "").match(/(?:^|\/)fullpage\.([\w.-]+)\.js(?:\?.*)?$/)?.[1]
  if (!FULLPAGE_PROTOCOLS[version]) throw new Error("本地尚未支持该极验初始协议版本，请使用后续过码方案")
  return { version, ...FULLPAGE_PROTOCOLS[version] }
}

export function geetestAssetUrl(resource, origin) {
  const url = new URL(resource, origin)
  if (url.protocol !== "https:" || !/(^|\.)(geetest\.com|geevisit\.com|geetest\.net)$/.test(url.hostname)) throw new Error("极验资源服务器无效")
  return url
}

export function knownGctScript(resource) {
  const url = new URL(resource)
  return GCT_SCRIPTS[url.pathname.split("/").at(-1)]
}

export function gctFields(resource, source) {
  const script = knownGctScript(resource)
  if (!script || crypto.createHash("sha256").update(source).digest("hex") !== script.sha256) {
    throw new Error("本地尚未支持该极验动态协议，请使用后续过码方案")
  }
  return { ...script.fields }
}
