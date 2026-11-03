export const CURRENT_GLOBAL_CONFIG_VERSION = 3

const ATLAS_BASE_SCOPE_ARGS = Object.freeze([
  "--game", "gi,hsr,zzz",
  "--locale", "zh",
  "--page", "gi=character,weapon,artifact,achievement/achievement,monster,tower,rolecombat,leyline",
  "--page", "hsr=character,lightcone,relicset,achievement/achievement,monster,monstervalue,EliteGroup,HardLevelGroup,InfiniteEliteGroup,maze,maze_peak,maze_boss,maze_extra",
  "--page", "zzz=character,weapon,equipment,bangboo,achievement/achievement,monster,shiyu,boss",
])

const ATLAS_CHALLENGE_SCOPE_ARGS = Object.freeze([
  "--game", "gi,hsr,zzz",
  "--locale", "zh",
  "--page", "gi=monster,tower,rolecombat,leyline",
  "--page", "hsr=monster,monstervalue,EliteGroup,HardLevelGroup,InfiniteEliteGroup,maze,maze_peak,maze_boss,maze_extra",
  "--page", "zzz=monster,shiyu,boss",
])

export const DEFAULT_GLOBAL_CONFIG = Object.freeze({
  version: CURRENT_GLOBAL_CONFIG_VERSION,
  coin_shop: {
    enable: true,
    mode: "auto",
    host: "127.0.0.1",
    port: 18164,
    path: "/lotus/coin-shop",
    public_url: "",
    icp_number: "",
    session_hours: 8,
  },
  scheduler: {
    enable: true,
    plan_generate_cron: "0 0 0 * * ? *",
    run_due_cron: "0 * * * * ? *",
    mode: "fixed",
    fixed_time: "04:30",
    random: {
      window_start: "00:00",
      window_end: "23:30",
      notify_before: true,
    },
    late_registration: {
      enable: true,
      window_start: "23:30",
      window_end: "23:59",
      notify: true,
    },
  },
  captcha: {
    providers: ["test_nine", "ttocr", "gtmanual"],
    refresh: {
      enable_on_challenge_used: true,
      max_attempts: 12,
    },
    retry: {
      provider_attempts: 3,
      chain_attempts: 2,
    },
    notify: {
      auto_recall: false,
      recall_seconds: 12,
    },
    test_nine: {
      enable: true,
      endpoint: "http://127.0.0.1:9645/pass_uni",
      timeout_ms: 60000,
      model_dir: "data/test_nine/model",
      model_repo: "luguoyixiazi/model_save",
      model_files: [
        "PP-HGNetV2-B4.onnx",
        "d-fine-n.onnx",
        "yolo11n.onnx",
        "dinov3-small.onnx",
        "atten.onnx",
      ],
    },
    ttocr: {
      enable: false,
      api: "http://api.ttocr.com/api/recognize",
      resapi: "http://api.ttocr.com/api/results",
      key: "",
      itemid_v4: 488,
      query: "itemid=388&referer=https://webstatic.mihoyo.com/",
      poll_interval_ms: 2000,
      timeout_ms: 60000,
    },
    gtmanual: {
      enable: true,
      verify_addr: "https://gt.lotusshared.cn/GTest/register?key=114514",
      timeout_ms: 180000,
      poll_interval_ms: 1500,
    },
    vision_ai: {
      enable: false,
      api: "",
      key: "",
      timeout_ms: 60000,
    },
  },
  tools: {
    dir: "data/tools",
    bin_dir: "data/tools/bin",
    github_api: "https://api.github.com",
    timeout_ms: 300000,
    download_retries: 3,
    ffmpeg: {
      repo: "BtbN/FFmpeg-Builds",
      command: "ffmpeg",
    },
  },
  remote: {
    enable: false,
    require_otp: true,
    otp_secret_env: "LOTUS_REMOTE_OTP_SECRET",
    timeout_ms: 30000,
    output_limit: 12000,
    max_download_bytes: 52428800,
    max_upload_bytes: 52428800,
    allow_overwrite_upload: false,
    restrict_file_paths: true,
    allowed_paths: ["data/remote"],
    allow_admin: false,
    shells: ["pwsh", "powershell", "cmd", "bash", "sh", "zsh"],
  },
  bilibili: {
    search_limit: 10,
    download: {
      enable: true,
      concurrency: 4,
      tools_path: "data/tools/bin",
      resolution: 64,
      duration_limit_seconds: 3600,
      video_size_limit_mb: 100,
      max_estimated_size_mb: 0,
      multi_page_policy: "zip",
      timeout_ms: 600000,
    },
  },
  douyin: {
    enable: true,
    request_timeout_ms: 15000,
    download: {
      enable: true,
      tools_path: "data/tools/bin",
      quality: "adapt",
      duration_limit_seconds: 3600,
      video_size_limit_mb: 100,
      max_estimated_size_mb: 0,
      multi_page_policy: "zip",
      timeout_ms: 600000,
    },
  },
  groups: {
    cleanup: {
      enable: true,
      dry_run: true,
      remove_group_fallback: true,
      delete_orphan_profiles: false,
      keep_if_private_possible: true,
    },
  },
  tuneweave: {
    api_url: "http://127.0.0.1:7832",
    request_timeout_ms: 30000,
    update_delay_ms: 180000,
  },
  music: {
    enable: true,
    default_platform: "netease",
    quality: "standard",
    search_limit: 10,
    session_timeout_ms: 120000,
    download_timeout_ms: 180000,
    max_size_mb: 128,
  },
  netease_partner: {
    enable: false,
    schedule: "0 5 0 * * ? *",
    auto_catch_up: false,
    notify_master: true,
    login_timeout_ms: 300000,
    login_poll_ms: 3000,
    delay_ms_min: 8000,
    delay_ms_max: 11000,
    comments: ["打卡支持"],
  },
  atlas: {
    data_root: "data/atlas",
    locale: "简体中文",
    max_results: 8,
    backend_root: "nanoka-atlas-backend",
    sync_after_update: true,
    sync_gallery: true,
    initial_command: "node",
    initial_args: ["src/scrape.mjs", "--mode", "full", ...ATLAS_BASE_SCOPE_ARGS],
    update_command: "node",
    update_args: ["src/scrape.mjs", "--mode", "incremental", ...ATLAS_BASE_SCOPE_ARGS],
    challenge_args: ["src/scrape.mjs", "--mode", "incremental", ...ATLAS_CHALLENGE_SCOPE_ARGS],
    version_command: "node",
    version_args: ["src/scrape.mjs", "--list-versions", "--game", "gi,hsr,zzz"],
    update_timeout_ms: 1800000,
    update_output_limit: 12000,
    auto_update: {
      enable: true,
      check_cron: "0 0 */6 * * ? *",
      challenge_cron: "0 15 */2 * * ? *",
      run_on_missing_data: true,
    },
  },
  permissions: {
    default_policy: "allow",
    users: {
      allow: [],
      deny: [],
    },
    groups: {
      allow: [],
      deny: [],
    },
    scopes: {
      "checkin.register": {
        policy: "inherit",
      },
      "checkin.refresh": {
        policy: "inherit",
      },
      "checkin.group_register": {
        policy: "master_only",
      },
      "scheduler.generate": {
        policy: "master_only",
      },
      "scheduler.run_due": {
        policy: "master_only",
      },
      "scheduler.manage": {
        policy: "master_only",
      },
      "remote.spawn": {
        policy: "master_only",
      },
      "remote.upload": {
        policy: "master_only",
      },
      "remote.download": {
        policy: "master_only",
      },
      "atlas.update": {
        policy: "master_only",
      },
      "plugin.update": {
        policy: "master_only",
      },
      "bilibili.login": {
        policy: "master_only",
      },
      "douyin.download": {
        policy: "inherit",
      },
      "bilibili.download": {
        policy: "inherit",
      },
      "tools.install": {
        policy: "master_only",
      },
      "group.members.export": {
        policy: "master_only",
      },
      "group.cleanup": {
        policy: "master_only",
      },
      "captcha.manage": {
        policy: "master_only",
      },
      "netease.partner": {
        policy: "master_only",
      },
    },
  },
})

export function createDefaultGlobalConfig() {
  return JSON.parse(JSON.stringify(DEFAULT_GLOBAL_CONFIG))
}
