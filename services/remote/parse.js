export function parseRemoteSpawn(message = "") {
  const match = String(message).match(/^#(?:(远程管理员spawn|admin\s+spawn|远程spawn|spawn))\s+(\d{6})\s+(pwsh|powershell|cmd)\s+([\s\S]+)$/i)
  if (!match) return null
  return {
    admin: /管理员|admin/i.test(match[1]),
    otp: match[2],
    shell: match[3].toLowerCase(),
    command: match[4],
  }
}

export function parseRemoteDownload(message = "") {
  const match = String(message).match(/^#远程下载\s+(\d{6})\s+([\s\S]+)$/i)
  if (!match) return null
  return {
    otp: match[1],
    file: match[2].trim(),
  }
}

export function parseRemoteUpload(message = "") {
  const match = String(message).match(/^#(?:远程上传(覆盖)?|上传)\s+(\d{6})\s+([\s\S]+)$/i)
  if (!match) return null
  return {
    overwrite: Boolean(match[1]),
    otp: match[2],
    target: match[3].trim(),
  }
}
