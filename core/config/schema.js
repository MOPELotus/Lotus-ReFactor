const SCHEDULE_MODES = new Set(["inherit", "random", "fixed"])
const GLOBAL_SCHEDULE_MODES = new Set(["random", "fixed"])
const NOTIFY_PREFERS = new Set(["private", "group"])
const PYTHON_MODES = new Set(["venv", "system"])
const PERMISSION_POLICIES = new Set(["allow", "deny", "inherit", "master_only"])
const BILI_MULTI_PAGE_POLICIES = new Set(["zip", "all", "first"])

export function validateProfile(profile) {
  const errors = []

  if (!profile || typeof profile !== "object") {
    return ["profile must be an object"]
  }

  if (!Number.isInteger(Number(profile.version)) || Number(profile.version) < 1) {
    errors.push("version must be a positive integer")
  }
  if (typeof profile.enabled !== "boolean") {
    errors.push("enabled must be boolean")
  }
  if (!profile.user?.qq) errors.push("user.qq is required")
  if (!Number.isInteger(Number(profile.profile?.id)) || Number(profile.profile.id) < 1 || Number(profile.profile.id) > 255) {
    errors.push("profile.id must be an integer from 1 to 255")
  }

  validateAccount(profile.account, errors)
  validateDevice(profile.device, errors)
  validateSchedule(profile.schedule, errors)
  validateNotify(profile.profile?.notify, errors)
  validateGames(profile.games, errors)
  validateCloudGames(profile.cloud_games, errors)

  return errors
}

export function assertValidProfile(profile) {
  const errors = validateProfile(profile)
  if (errors.length) {
    throw new Error(`Invalid profile config: ${errors.join("; ")}`)
  }
  return profile
}

export function validateGlobalConfig(config) {
  const errors = []

  if (!config || typeof config !== "object") {
    return ["global config must be an object"]
  }

  if (!Number.isInteger(Number(config.version)) || Number(config.version) < 1) {
    errors.push("version must be a positive integer")
  }

  validateRenderConfig(config.render, errors)
  validateGlobalScheduler(config.scheduler, errors)
  validateCaptchaConfig(config.captcha, errors)
  validatePythonConfig(config.python, errors)
  validateToolsConfig(config.tools, errors)
  validateRemoteConfig(config.remote, errors)
  validateBilibiliConfig(config.bilibili, errors)
  validateGroupsConfig(config.groups, errors)
  validateNeteasePartnerConfig(config.netease_partner, errors)
  validateLoggingConfig(config.logging, errors)
  validateAtlasConfig(config.atlas, errors)
  validatePermissionConfig(config.permissions, errors)

  return errors
}

export function assertValidGlobalConfig(config) {
  const errors = validateGlobalConfig(config)
  if (errors.length) {
    throw new Error(`Invalid global config: ${errors.join("; ")}`)
  }
  return config
}

function validateAccount(account = {}, errors) {
  if (!isObject(account)) {
    errors.push("account must be an object")
    return
  }
  for (const game of ["gs", "sr", "zzz"]) {
    if (!Array.isArray(account.game_roles?.[game])) {
      errors.push(`account.game_roles.${game} must be an array`)
    }
  }
  if (!isObject(account.current_uid)) {
    errors.push("account.current_uid must be an object")
  }
}

function validateDevice(device = {}, errors) {
  if (!isObject(device)) {
    errors.push("device must be an object")
    return
  }
  if (typeof device.bound !== "boolean") {
    errors.push("device.bound must be boolean")
  }
}

function validateSchedule(schedule = {}, errors) {
  if (!isObject(schedule)) {
    errors.push("schedule must be an object")
    return
  }
  if (!SCHEDULE_MODES.has(schedule.mode)) {
    errors.push("schedule.mode must be inherit/random/fixed")
  }
  if (schedule.mode === "fixed" && schedule.fixed_time && !/^\d{2}:\d{2}$/.test(schedule.fixed_time)) {
    errors.push("schedule.fixed_time must be HH:mm")
  }
}

function validateNotify(notify = {}, errors) {
  if (!isObject(notify)) {
    errors.push("profile.notify must be an object")
    return
  }
  if ("enable" in notify && typeof notify.enable !== "boolean") {
    errors.push("profile.notify.enable must be boolean")
  }
  if (!NOTIFY_PREFERS.has(notify.prefer)) {
    errors.push("profile.notify.prefer must be private/group")
  }
  if (!Array.isArray(notify.fallback_groups)) {
    errors.push("profile.notify.fallback_groups must be an array")
  }
}

function validateGames(games = {}, errors) {
  if (!isObject(games?.cn)) errors.push("games.cn must be an object")
  for (const game of ["genshin", "honkai_sr", "zzz"]) {
    if (!isObject(games?.cn?.[game])) errors.push(`games.cn.${game} must be an object`)
  }
  if (!isObject(games?.os)) errors.push("games.os must be an object")
}

function validateCloudGames(cloud = {}, errors) {
  if (!isObject(cloud?.cn)) {
    errors.push("cloud_games.cn must be an object")
    return
  }
  for (const game of ["genshin", "zzz"]) {
    if (!isObject(cloud.cn[game])) errors.push(`cloud_games.cn.${game} must be an object`)
  }
}

function validateRenderConfig(render = {}, errors) {
  if (!isObject(render)) {
    errors.push("render must be an object")
    return
  }
  if (!isString(render.background)) errors.push("render.background must be a string")
  if (!isString(render.theme_color)) errors.push("render.theme_color must be a string")
  if (!isPositiveInteger(render.background_timeout_ms)) {
    errors.push("render.background_timeout_ms must be a positive integer")
  }
}

function validateGlobalScheduler(scheduler = {}, errors) {
  if (!isObject(scheduler)) {
    errors.push("scheduler must be an object")
    return
  }
  if (typeof scheduler.enable !== "boolean") errors.push("scheduler.enable must be boolean")
  if (!isString(scheduler.plan_generate_cron)) errors.push("scheduler.plan_generate_cron must be a string")
  if (!isString(scheduler.run_due_cron)) errors.push("scheduler.run_due_cron must be a string")
  if (!GLOBAL_SCHEDULE_MODES.has(scheduler.mode)) {
    errors.push("scheduler.mode must be random/fixed")
  }
  if (!isTime(scheduler.fixed_time)) errors.push("scheduler.fixed_time must be HH:mm")

  if (!isObject(scheduler.random)) {
    errors.push("scheduler.random must be an object")
  } else {
    if (!isTime(scheduler.random.window_start)) errors.push("scheduler.random.window_start must be HH:mm")
    if (!isTime(scheduler.random.window_end)) errors.push("scheduler.random.window_end must be HH:mm")
    if (typeof scheduler.random.notify_before !== "boolean") {
      errors.push("scheduler.random.notify_before must be boolean")
    }
  }

  if (!isObject(scheduler.late_registration)) {
    errors.push("scheduler.late_registration must be an object")
  } else {
    if (typeof scheduler.late_registration.enable !== "boolean") {
      errors.push("scheduler.late_registration.enable must be boolean")
    }
    if (!isTime(scheduler.late_registration.window_start)) {
      errors.push("scheduler.late_registration.window_start must be HH:mm")
    }
    if (!isTime(scheduler.late_registration.window_end)) {
      errors.push("scheduler.late_registration.window_end must be HH:mm")
    }
    if (typeof scheduler.late_registration.notify !== "boolean") {
      errors.push("scheduler.late_registration.notify must be boolean")
    }
  }
}

function validateCaptchaConfig(captcha = {}, errors) {
  if (!isObject(captcha)) {
    errors.push("captcha must be an object")
    return
  }
  if (!Array.isArray(captcha.providers) || !captcha.providers.every(isString)) {
    errors.push("captcha.providers must be an array of strings")
  }
  if (!isObject(captcha.refresh)) {
    errors.push("captcha.refresh must be an object")
  } else {
    if (typeof captcha.refresh.enable_on_challenge_used !== "boolean") {
      errors.push("captcha.refresh.enable_on_challenge_used must be boolean")
    }
    if (!isNonNegativeInteger(captcha.refresh.max_attempts)) {
      errors.push("captcha.refresh.max_attempts must be a non-negative integer")
    }
  }
  if (typeof captcha.retry !== "undefined") {
    if (!isObject(captcha.retry)) {
      errors.push("captcha.retry must be an object")
    } else {
      if (!isPositiveInteger(captcha.retry.provider_attempts)) {
        errors.push("captcha.retry.provider_attempts must be a positive integer")
      }
      if (!isPositiveInteger(captcha.retry.chain_attempts)) {
        errors.push("captcha.retry.chain_attempts must be a positive integer")
      }
    }
  }
  if (typeof captcha.notify !== "undefined") {
    if (!isObject(captcha.notify)) {
      errors.push("captcha.notify must be an object")
    } else {
      if (typeof captcha.notify.auto_recall !== "boolean") {
        errors.push("captcha.notify.auto_recall must be boolean")
      }
      if (!isNonNegativeInteger(captcha.notify.recall_seconds)) {
        errors.push("captcha.notify.recall_seconds must be a non-negative integer")
      }
    }
  }

  validateProvider(captcha.test_nine, "captcha.test_nine", errors, [
    "endpoint",
    "submodule_path",
    "venv_path",
    "model_dir",
    "model_repo",
  ])
  if (isObject(captcha.test_nine)) {
    if (!Array.isArray(captcha.test_nine.model_files) || !captcha.test_nine.model_files.every(isString)) {
      errors.push("captcha.test_nine.model_files must be an array of strings")
    }
    for (const field of ["auto_start", "install_requirements", "download_models"]) {
      if (typeof captcha.test_nine[field] !== "boolean") {
        errors.push(`captcha.test_nine.${field} must be boolean`)
      }
    }
  }
  validateProvider(captcha.ttocr, "captcha.ttocr", errors, ["api", "resapi", "key", "query"])
  if (isObject(captcha.ttocr) && Number(captcha.ttocr.poll_interval_ms) < 1000) {
    errors.push("captcha.ttocr.poll_interval_ms must be at least 1000")
  }
  validateProvider(captcha.gtmanual, "captcha.gtmanual", errors, ["address", "verify_addr"])
  validateProvider(captcha.vision_ai, "captcha.vision_ai", errors, ["api", "key"])
}

function validateProvider(provider = {}, prefix, errors, stringFields = []) {
  if (!isObject(provider)) {
    errors.push(`${prefix} must be an object`)
    return
  }
  if (typeof provider.enable !== "boolean") errors.push(`${prefix}.enable must be boolean`)
  for (const field of stringFields) {
    if (!isString(provider[field])) errors.push(`${prefix}.${field} must be a string`)
  }
  if ("timeout_ms" in provider && !isPositiveInteger(provider.timeout_ms)) {
    errors.push(`${prefix}.timeout_ms must be a positive integer`)
  }
  if ("poll_interval_ms" in provider && !isPositiveInteger(provider.poll_interval_ms)) {
    errors.push(`${prefix}.poll_interval_ms must be a positive integer`)
  }
}

function validatePythonConfig(python = {}, errors) {
  if (!isObject(python)) {
    errors.push("python must be an object")
    return
  }
  if (!PYTHON_MODES.has(python.mode)) errors.push("python.mode must be venv/system")
  if (!isString(python.venv_path)) errors.push("python.venv_path must be a string")
  if (!isString(python.system_python)) errors.push("python.system_python must be a string")
}

function validateToolsConfig(tools = {}, errors) {
  if (!isObject(tools)) {
    errors.push("tools must be an object")
    return
  }
  if (typeof tools.auto_install !== "boolean") errors.push("tools.auto_install must be boolean")
  for (const field of ["dir", "bin_dir", "github_api"]) {
    if (!isString(tools[field])) errors.push(`tools.${field} must be a string`)
  }
  if (!isPositiveInteger(tools.timeout_ms)) errors.push("tools.timeout_ms must be a positive integer")
  for (const name of ["bbdown", "ffmpeg", "aria2"]) {
    validateToolConfig(tools[name], `tools.${name}`, errors)
  }
}

function validateToolConfig(tool = {}, prefix, errors) {
  if (!isObject(tool)) {
    errors.push(`${prefix} must be an object`)
    return
  }
  if (typeof tool.enable !== "boolean") errors.push(`${prefix}.enable must be boolean`)
  for (const field of ["repo", "command"]) {
    if (!isString(tool[field])) errors.push(`${prefix}.${field} must be a string`)
  }
}

function validateRemoteConfig(remote = {}, errors) {
  if (!isObject(remote)) {
    errors.push("remote must be an object")
    return
  }
  for (const field of ["enable", "require_otp", "allow_overwrite_upload", "restrict_file_paths", "allow_admin"]) {
    if (typeof remote[field] !== "boolean") errors.push(`remote.${field} must be boolean`)
  }
  for (const field of ["timeout_ms", "output_limit", "max_download_bytes", "max_upload_bytes"]) {
    if (!isPositiveInteger(remote[field])) errors.push(`remote.${field} must be a positive integer`)
  }
  if (!isString(remote.otp_secret_env)) errors.push("remote.otp_secret_env must be a string")
  if (!Array.isArray(remote.allowed_paths) || !remote.allowed_paths.every(isString)) {
    errors.push("remote.allowed_paths must be an array of strings")
  }
  if (!Array.isArray(remote.shells) || !remote.shells.every(isString)) {
    errors.push("remote.shells must be an array of strings")
  }
}

function validateBilibiliConfig(bilibili = {}, errors) {
  if (!isObject(bilibili)) {
    errors.push("bilibili must be an object")
    return
  }
  if (!isString(bilibili.cookie)) errors.push("bilibili.cookie must be a string")
  if (!isString(bilibili.sessdata)) errors.push("bilibili.sessdata must be a string")
  if (!isPositiveInteger(bilibili.search_limit)) errors.push("bilibili.search_limit must be a positive integer")

  if (!isObject(bilibili.download)) {
    errors.push("bilibili.download must be an object")
    return
  }
  for (const field of ["enable", "use_aria2", "cache_enable"]) {
    if (typeof bilibili.download[field] !== "boolean") {
      errors.push(`bilibili.download.${field} must be boolean`)
    }
  }
  for (const field of ["tools_path"]) {
    if (!isString(bilibili.download[field])) errors.push(`bilibili.download.${field} must be a string`)
  }
  for (const field of [
    "resolution",
    "duration_limit_seconds",
    "video_size_limit_mb",
    "timeout_ms",
  ]) {
    if (!isPositiveInteger(bilibili.download[field])) {
      errors.push(`bilibili.download.${field} must be a positive integer`)
    }
  }
  for (const field of ["max_estimated_size_mb", "cache_ttl_seconds"]) {
    if (!isNonNegativeInteger(bilibili.download[field])) {
      errors.push(`bilibili.download.${field} must be a non-negative integer`)
    }
  }
  if (!BILI_MULTI_PAGE_POLICIES.has(bilibili.download.multi_page_policy)) {
    errors.push("bilibili.download.multi_page_policy must be zip/all/first")
  }
  if (!Array.isArray(bilibili.download.extra_args) || !bilibili.download.extra_args.every(isString)) {
    errors.push("bilibili.download.extra_args must be an array of strings")
  }
}

function validateGroupsConfig(groups = {}, errors) {
  if (!isObject(groups)) {
    errors.push("groups must be an object")
    return
  }
  if (!isObject(groups.cleanup)) {
    errors.push("groups.cleanup must be an object")
    return
  }
  for (const field of [
    "enable",
    "dry_run",
    "remove_group_fallback",
    "delete_orphan_profiles",
    "keep_if_private_possible",
  ]) {
    if (typeof groups.cleanup[field] !== "boolean") {
      errors.push(`groups.cleanup.${field} must be boolean`)
    }
  }
}

function validateNeteasePartnerConfig(netease = {}, errors) {
  if (!isObject(netease)) {
    errors.push("netease_partner must be an object")
    return
  }
  if (typeof netease.enable !== "boolean") errors.push("netease_partner.enable must be boolean")
  for (const field of ["api_url", "schedule"]) {
    if (!isString(netease[field])) errors.push(`netease_partner.${field} must be a string`)
  }
  for (const field of ["login_timeout_ms", "login_poll_ms", "delay_ms_min", "delay_ms_max"]) {
    if (!isPositiveInteger(netease[field])) errors.push(`netease_partner.${field} must be a positive integer`)
  }
  if (Number(netease.delay_ms_min) > Number(netease.delay_ms_max)) {
    errors.push("netease_partner.delay_ms_min must be <= delay_ms_max")
  }
  if (typeof netease.auto_catch_up !== "boolean") {
    errors.push("netease_partner.auto_catch_up must be boolean")
  }
  if (!Array.isArray(netease.comments) || !netease.comments.every(isString)) {
    errors.push("netease_partner.comments must be an array of strings")
  }
}

function validateLoggingConfig(logging = {}, errors) {
  if (!isObject(logging)) {
    errors.push("logging must be an object")
    return
  }
  if (!isPositiveInteger(logging.retention_days)) errors.push("logging.retention_days must be a positive integer")
  if (typeof logging.redact_sensitive !== "boolean") errors.push("logging.redact_sensitive must be boolean")
}

function validateAtlasConfig(atlas = {}, errors) {
  if (!isObject(atlas)) {
    errors.push("atlas must be an object")
    return
  }
  for (const field of ["data_root", "locale", "backend_root", "initial_command", "update_command", "version_command"]) {
    if (!isString(atlas[field])) errors.push(`atlas.${field} must be a string`)
  }
  for (const field of ["sync_after_update", "sync_gallery"]) {
    if (typeof atlas[field] !== "boolean") errors.push(`atlas.${field} must be boolean`)
  }
  if (!isPositiveInteger(atlas.max_results)) errors.push("atlas.max_results must be a positive integer")
  for (const field of ["initial_args", "update_args", "version_args"]) {
    if (!Array.isArray(atlas[field]) || !atlas[field].every(isString)) {
      errors.push(`atlas.${field} must be an array of strings`)
    }
  }
  if (!isPositiveInteger(atlas.update_timeout_ms)) errors.push("atlas.update_timeout_ms must be a positive integer")
  if (!isPositiveInteger(atlas.update_output_limit)) errors.push("atlas.update_output_limit must be a positive integer")
  if (!isObject(atlas.auto_update)) {
    errors.push("atlas.auto_update must be an object")
  } else {
    if (typeof atlas.auto_update.enable !== "boolean") errors.push("atlas.auto_update.enable must be boolean")
    if (!isString(atlas.auto_update.check_cron)) errors.push("atlas.auto_update.check_cron must be a string")
    if (typeof atlas.auto_update.run_on_missing_data !== "boolean") {
      errors.push("atlas.auto_update.run_on_missing_data must be boolean")
    }
  }
}

function validatePermissionConfig(permissions = {}, errors) {
  if (!isObject(permissions)) {
    errors.push("permissions must be an object")
    return
  }
  if (!PERMISSION_POLICIES.has(permissions.default_policy)) {
    errors.push("permissions.default_policy must be allow/deny/inherit/master_only")
  }
  validatePermissionList(permissions.users, "permissions.users", errors)
  validatePermissionList(permissions.groups, "permissions.groups", errors)
  if (!isObject(permissions.scopes)) {
    errors.push("permissions.scopes must be an object")
  } else {
    for (const [scope, rule] of Object.entries(permissions.scopes)) {
      if (!isObject(rule)) {
        errors.push(`permissions.scopes.${scope} must be an object`)
      } else if (!PERMISSION_POLICIES.has(rule.policy)) {
        errors.push(`permissions.scopes.${scope}.policy must be allow/deny/inherit/master_only`)
      }
    }
  }
}

function validatePermissionList(value = {}, prefix, errors) {
  if (!isObject(value)) {
    errors.push(`${prefix} must be an object`)
    return
  }
  for (const field of ["allow", "deny"]) {
    if (!Array.isArray(value[field]) || !value[field].every(isStringLike)) {
      errors.push(`${prefix}.${field} must be an array of strings`)
    }
  }
}

function isObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
}

function isString(value) {
  return typeof value === "string"
}

function isStringLike(value) {
  return typeof value === "string" || typeof value === "number"
}

function isPositiveInteger(value) {
  return Number.isInteger(Number(value)) && Number(value) > 0
}

function isNonNegativeInteger(value) {
  return Number.isInteger(Number(value)) && Number(value) >= 0
}

function isTime(value) {
  return typeof value === "string"
    && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)
}
