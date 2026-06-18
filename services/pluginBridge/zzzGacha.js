import { ZzzGachaService } from "../zzzGacha/service.js"

export class ZzzGachaBridge {
  constructor(options = {}) {
    this.service = options.service || new ZzzGachaService(options)
  }

  async updateGachaLog({ e, profile, profileId = 1 } = {}) {
    return this.service.updateByProfile({
      qq: String(e?.user_id || profile?.user?.qq || ""),
      profile,
      profileId,
    })
  }
}
