// QR confirmations can contain a valid session without its account identity.
// Login uses credential_mode=both, so the same alias can resolve that identity.
export async function resolveQrProfile(tuneweave, { platform, alias, profile, signal }) {
  const checkCancelled = () => {
    if (signal?.aborted) throw new Error("扫码登录已取消")
  }
  const checkBinding = value => {
    if (value?.platform && value.platform !== platform || value?.account && value.account !== alias) throw new Error("平台登录账号不匹配，请重新登录")
  }
  checkCancelled()
  checkBinding(profile)
  if (!profile?.authenticated || !profile.user_id) {
    profile = await tuneweave.request(`/v1/account?${new URLSearchParams({ platform, account: alias })}`)
  }
  checkCancelled()
  checkBinding(profile)
  if (!profile?.authenticated || !profile.user_id) throw new Error("平台登录身份未核验，请重新登录")
  return profile
}
