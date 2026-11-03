import { randomBytes, randomInt, randomUUID } from "node:crypto"

// Keep model, OS and firmware together. These are compatible Pixel factory
// configurations, not independently selected Android/model strings.
// https://developers.google.com/android/images (SD1A.210817.015.A4)
// https://developers.google.com/android/binary_transparency/pixel_verification
// Complete fingerprints are published in the official transparency log:
// https://developers.google.com/android/binary_transparency/image_info.txt
// https://support.google.com/pixelphone/answer/7158570
export const VIRTUAL_DEVICE_TEMPLATES = Object.freeze([
  Object.freeze({ id: "pixel6-android12", model: "Pixel 6", product: "oriole", board: "oriole", screen: "1080x2400", ram: "8192", os: "12", sdk: "31", build: "SD1A.210817.015.A4", incremental: "7697517" }),
  Object.freeze({ id: "pixel6pro-android12", model: "Pixel 6 Pro", product: "raven", board: "raven", screen: "1440x3120", ram: "12288", os: "12", sdk: "31", build: "SD1A.210817.015.A4", incremental: "7697517" }),
  Object.freeze({ id: "pixel7-android13", model: "Pixel 7", product: "panther", board: "panther", screen: "1080x2400", ram: "8192", os: "13", sdk: "33", build: "TQ1A.221205.011", incremental: "9244662" }),
  Object.freeze({ id: "pixel7pro-android14", model: "Pixel 7 Pro", product: "cheetah", board: "cheetah", screen: "1440x3120", ram: "12288", os: "14", sdk: "34", build: "UP1A.231105.003", incremental: "11010452" }),
  Object.freeze({ id: "pixel8-android14", model: "Pixel 8", product: "shiba", board: "shiba", screen: "1080x2400", ram: "8192", os: "14", sdk: "34", build: "UQ1A.240205.004", incremental: "11269751" }),
  Object.freeze({ id: "pixel8pro-android14", model: "Pixel 8 Pro", product: "husky", board: "husky", screen: "1344x2992", ram: "12288", os: "14", sdk: "34", build: "UD1A.231105.004", incremental: "11010374" }),
])

export function generateVirtualDevice({ templateId } = {}) {
  const template = templateId === undefined
    ? VIRTUAL_DEVICE_TEMPLATES[randomInt(VIRTUAL_DEVICE_TEMPLATES.length)]
    : VIRTUAL_DEVICE_TEMPLATES.find(item => item.id === templateId)
  if (!template) throw new Error("Unknown virtual device template")
  const raw = {
    bbsDeviceId: randomUUID(),
    deviceName: template.model,
    deviceModel: template.model,
    deviceBrand: "google",
    manufacturer: "Google",
    deviceProduct: template.product,
    deviceBoard: template.board,
    deviceFingerprint: `google/${template.product}/${template.product}:${template.os}/${template.build}/${template.incremental}:user/release-keys`,
    osVersion: template.os,
    sdkVersion: template.sdk,
    screenSize: template.screen,
    ramCapacity: template.ram,
    romCapacity: randomInt(2) ? "256" : "128",
    oaid: randomBytes(32).toString("hex"),
  }
  return {
    bound: false,
    generated: true,
    generation_version: 1,
    instance_id: randomBytes(16).toString("hex"),
    template_id: template.id,
    name: template.model,
    model: template.model,
    id: randomBytes(16).toString("hex"),
    // Only the official getFp response may populate this field.
    fp: "",
    android_version: template.os,
    raw,
  }
}

export function needsGeneratedDevice(device = {}) {
  // Never reinterpret a manually bound device or replace an existing identity
  // (even a partial legacy identity) with a different virtual phone.
  return !device?.bound && !String(device?.id || "").trim() && !String(device?.fp || "").trim()
}
