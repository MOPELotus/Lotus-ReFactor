export const CURRENT_GLOBAL_CONFIG_VERSION = 1

export const DEFAULT_GLOBAL_CONFIG = Object.freeze({
  version: CURRENT_GLOBAL_CONFIG_VERSION,
  render: {
    background: "https://v2.xxapi.cn/api/ys",
    theme_color: "#66ccff",
    background_timeout_ms: 3000,
  },
  scheduler: {
    enable: true,
    plan_generate_cron: "0 30 10 * * ?",
    run_due_cron: "0 * * * * ?",
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
      max_attempts: 1,
    },
    test_nine: {
      enable: true,
      endpoint: "http://127.0.0.1:9645/pass_uni",
      timeout_ms: 20000,
      submodule_path: "test_nine",
      venv_path: "data/python/test_nine_venv",
      model_dir: "data/test_nine/model",
      model_repo: "luguoyixiazi/model_save",
      model_files: [
        "PP-HGNetV2-B4.onnx",
        "d-fine-n.onnx",
        "yolo11n.onnx",
        "dinov3-small.onnx",
        "atten.onnx",
      ],
      install_requirements: true,
      download_models: true,
    },
    ttocr: {
      enable: false,
      api: "http://api.ttocr.com/api/recognize",
      resapi: "http://api.ttocr.com/api/results",
      key: "",
      query: "itemid=388&referer=https://webstatic.mihoyo.com/",
      poll_interval_ms: 1000,
      timeout_ms: 60000,
    },
    gtmanual: {
      enable: true,
      address: "https://gt.lotusshared.cn/",
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
  python: {
    mode: "venv",
    venv_path: "data/python/venv",
    system_python: "",
  },
  tools: {
    auto_install: true,
    dir: "data/tools",
    bin_dir: "data/tools/bin",
    github_api: "https://api.github.com",
    timeout_ms: 300000,
    bbdown: {
      enable: true,
      repo: "nilaoda/BBDown",
      command: "BBDown",
    },
    ffmpeg: {
      enable: true,
      repo: "BtbN/FFmpeg-Builds",
      command: "ffmpeg",
    },
    aria2: {
      enable: true,
      repo: "aria2/aria2",
      command: "aria2c",
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
    shells: ["pwsh", "powershell", "cmd"],
  },
  bilibili: {
    cookie: "",
    sessdata: "",
    search_limit: 10,
    download: {
      enable: true,
      use_aria2: true,
      tools_path: "data/tools/bin",
      resolution: 64,
      duration_limit_seconds: 3600,
      video_size_limit_mb: 100,
      max_estimated_size_mb: 0,
      multi_page_policy: "zip",
      cache_enable: true,
      cache_ttl_seconds: 0,
      timeout_ms: 600000,
      extra_args: [],
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
  netease_partner: {
    enable: false,
    api_url: "http://127.0.0.1:3000",
    schedule: "0 5 0 * * *",
    auto_catch_up: false,
    login_timeout_ms: 300000,
    login_poll_ms: 3000,
    delay_ms_min: 8000,
    delay_ms_max: 11000,
    comments: ["打卡支持"],
  },
  logging: {
    retention_days: 14,
    redact_sensitive: true,
  },
  atlas: {
    data_root: "data/atlas",
    locale: "简体中文",
    max_results: 8,
    backend_root: "nanoka-atlas-backend",
    sync_after_update: true,
    sync_gallery: true,
    initial_command: "node",
    initial_args: ["src/scrape.mjs", "--mode", "full"],
    update_command: "node",
    update_args: ["src/scrape.mjs", "--mode", "incremental"],
    version_command: "node",
    version_args: ["src/scrape.mjs", "--list-versions"],
    update_timeout_ms: 1800000,
    update_output_limit: 12000,
    auto_update: {
      enable: true,
      check_cron: "0 0 */6 * * ?",
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
      "permissions.manage": {
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
