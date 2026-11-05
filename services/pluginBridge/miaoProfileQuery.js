import { registerProfileWithGenshin } from "../genshinBridge/profile.js"
import { createMiaoProfileEvent } from "./miaoPanel.js"
import { importRuntimeModule } from "./common.js"
import { withMysRequestProfile } from "../intercept/mys-request-context.js"

export class MiaoProfileQueryBridge {
  constructor(options = {}) {
    this.registerProfile = options.registerProfile || registerProfileWithGenshin
    this.loadProfileArtis = options.loadProfileArtis || loadProfileArtis
    this.loadProfileRank = options.loadProfileRank || loadProfileRank
    this.loadProfileList = options.loadProfileList || loadProfileList
    this.loadProfileDetail = options.loadProfileDetail || loadProfileDetail
    this.loadProfileStat = options.loadProfileStat || loadProfileStat
    this.loadAbyssSummary = options.loadAbyssSummary || loadAbyssSummary
    this.loadRoleCombatSummary = options.loadRoleCombatSummary || loadRoleCombatSummary
    this.loadHardChallengeSummary = options.loadHardChallengeSummary || loadHardChallengeSummary
  }

  async refreshTalent(options = {}) {
    const ProfileStat = await this.loadProfileStat()
    return this.run(options, event => ProfileStat.refreshTalent(event))
  }

  async reloadProfile(options = {}) {
    const ProfileList = await this.loadProfileList()
    return this.run(options, event => ProfileList.reload(event))
  }

  async deleteProfile(options = {}) {
    const ProfileList = await this.loadProfileList()
    return this.run(options, event => ProfileList.del(event))
  }

  async artisList(options = {}) {
    const fn = await this.loadProfileArtis()
    return this.run(options, event => fn(event))
  }

  async groupRank(options = {}) {
    const fn = await this.loadProfileRank()
    return this.run(options, event => fn(event))
  }

  async profileList(options = {}) {
    const ProfileList = await this.loadProfileList()
    return this.run(options, event => ProfileList.render(event))
  }

  async profileDetail(options = {}) {
    const ProfileDetail = await this.loadProfileDetail()
    return this.run(options, event => ProfileDetail.detail(event))
  }

  async profileStat(options = {}) {
    const ProfileStat = await this.loadProfileStat()
    return this.run(options, event => ProfileStat.stat(event))
  }

  async avatarList(options = {}) {
    const ProfileStat = await this.loadProfileStat()
    return this.run(options, event => ProfileStat.avatarList(event))
  }

  async talentStat(options = {}) {
    const ProfileStat = await this.loadProfileStat()
    return this.run(options, event => ProfileStat.stat(event))
  }

  async roleCombatStat(options = {}) {
    const ProfileStat = await this.loadProfileStat()
    return this.run(options, event => ProfileStat.roleStat(event))
  }

  async abyssSummary(options = {}) {
    const fn = await this.loadAbyssSummary()
    return this.run(options, event => fn(event))
  }

  async roleCombatSummary(options = {}) {
    const fn = await this.loadRoleCombatSummary()
    return this.run(options, event => fn(event))
  }

  async hardChallengeSummary(options = {}) {
    const fn = await this.loadHardChallengeSummary()
    return this.run(options, event => fn(event))
  }

  async run({ e, profile, profileId = 1, game = "gs", command, forwardReplies = true } = {}, handler) {
    const context = await createMiaoProfileEvent({
      e,
      profile,
      profileId,
      game,
      msg: command,
      forwardReplies,
      registerProfile: this.registerProfile,
    })
    await withMysRequestProfile(profile, () => handler(context.event))
    return {
      ok: true,
      game,
      uid: context.uid,
      profileId,
      messages: context.messages.filter(Boolean),
      forwarded: context.forwarded,
    }
  }
}

async function loadProfileList() {
  const mod = await importRuntimeModule("miao-plugin", "apps", "profile", "ProfileList.js")
  return mod.default
}

async function loadProfileDetail() {
  const mod = await importRuntimeModule("miao-plugin", "apps", "profile", "ProfileDetail.js")
  return mod.default
}

async function loadProfileStat() {
  const mod = await importRuntimeModule("miao-plugin", "apps", "profile", "ProfileStat.js")
  return mod.default
}

async function loadAbyssSummary() {
  const mod = await importRuntimeModule("miao-plugin", "apps", "stat", "AbyssSummary.js")
  return mod.AbyssSummary
}

async function loadRoleCombatSummary() {
  const mod = await importRuntimeModule("miao-plugin", "apps", "stat", "RoleCombatSummary.js")
  return mod.RoleCombatSummary
}

async function loadHardChallengeSummary() {
  const mod = await importRuntimeModule("miao-plugin", "apps", "stat", "HardChallengeSummary.js")
  return mod.HardChallengeSummary
}

async function loadProfileArtis() {
  return (await importRuntimeModule("miao-plugin", "apps", "profile", "ProfileArtis.js")).profileArtisList
}

async function loadProfileRank() {
  return (await importRuntimeModule("miao-plugin", "apps", "profile", "ProfileRank.js")).groupRank
}
