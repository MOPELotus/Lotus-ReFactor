import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ToolInstallerService, pickReleaseAsset, parseBBDownVersion } from "../services/tools/installer.js"
import { migrateGlobalConfig } from "../core/config/global.js"
import { checkBBDownUpdate, updateBBDownAfterStartup, scheduleBBDownStartupUpdate } from "../services/tools/startup.js"

const executable = version => `#!/bin/sh\nprintf 'BBDown version ${version}, Bilibili Downloader.\\n'\n`
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lotus-bbdown-"))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const bin = path.join(dir, "bin")
  await fs.mkdir(bin)
  const config = { tools: { dir: path.join(dir, "tools"), bin_dir: bin, download_retries: 1 } }
  const urls = []
  const installer = new ToolInstallerService({ config: config.tools, fetch: async url => {
    urls.push(url)
    if (url.includes("/releases/tags/")) return Response.json({ assets: [{ name: "BBDown_1.6.4_linux-x64", browser_download_url: "https://example.test/BBDown" }] })
    return new Response(executable("1.6.4"))
  } })
  return { dir, bin, config, installer, urls }
}

test("fork assets select the correct OS and CPU for all six platforms", () => {
  const assets = ["linux-x64", "linux-arm64", "osx-x64", "osx-arm64", "win-x64.exe", "win-arm64.exe"].map(p => ({ name: `BBDown_1.6.4_${p}`, browser_download_url: "https://example.test" }))
  for (const [platform, name] of [["linux", "linux"], ["darwin", "osx"], ["win32", "win"]]) {
    for (const arch of ["x64", "arm64"]) assert.equal(pickReleaseAsset("bbdown", assets, { platform, arch }).name, `BBDown_1.6.4_${name}-${arch}${platform === "win32" ? ".exe" : ""}`)
  }
  assert.equal(parseBBDownVersion("BBDown version 1.6.3, Bilibili Downloader."), "1.6.3")
  assert.equal(migrateGlobalConfig({ tools: { bbdown: { repo: "nilaoda/BBDown" } } }).tools.bbdown.repo, "MOPELotus/BBDown")
  assert.equal(migrateGlobalConfig({ tools: { bbdown: { repo: "custom/BBDown" } } }).tools.bbdown.repo, "custom/BBDown")
})

test("automatic update replaces old symlink, keeps its target and login files, then skips 1.6.4", async t => {
  const f = await fixture(t)
  const old = path.join(f.dir, "external-BBDown")
  await fs.writeFile(old, executable("1.6.3"), { mode: 0o755 })
  await fs.symlink(old, path.join(f.bin, "BBDown"))
  await fs.writeFile(path.join(f.bin, "BBDown.data"), "login-fixture")
  assert.equal((await checkBBDownUpdate(f.config, f.installer)).version, "1.6.3")
  const notices = []
  await updateBBDownAfterStartup({ config: f.config, installer: f.installer, notify: async msg => notices.push(msg) })
  assert.equal((await fs.lstat(path.join(f.bin, "BBDown"))).isSymbolicLink(), false)
  assert.equal(await fs.readFile(old, "utf8"), executable("1.6.3"))
  assert.equal(await fs.readFile(path.join(f.bin, "BBDown.data"), "utf8"), "login-fixture")
  assert.equal(await f.installer.readBBDownVersion(path.join(f.bin, "BBDown")), "1.6.4")
  assert.equal(f.urls[0], "https://api.github.com/repos/MOPELotus/BBDown/releases/tags/1.6.4")
  assert.match(notices[0], /正在自动更新/)
  assert.equal(notices.length, 2)
  await updateBBDownAfterStartup({ config: f.config, installer: f.installer, notify: async msg => notices.push(msg) })
  assert.equal(notices.length, 2)
})

test("bad download leaves existing executable intact and sends failure notification", async t => {
  const f = await fixture(t)
  const target = path.join(f.bin, "BBDown")
  await fs.writeFile(target, executable("1.6.3"), { mode: 0o755 })
  const fetch = f.installer.fetch
  f.installer.fetch = url => url.includes("/releases/") ? fetch(url) : Promise.resolve(new Response(executable("1.6.2")))
  const notices = []
  await assert.rejects(updateBBDownAfterStartup({ config: f.config, installer: f.installer, notify: async msg => notices.push(msg) }), /版本不匹配/)
  assert.equal(await f.installer.readBBDownVersion(target), "1.6.3")
  assert.match(notices.at(-1), /自动更新失败/)
})

test("startup schedules once for five minutes after process boot and disabled installs skip", async t => {
  const f = await fixture(t)
  assert.equal((await checkBBDownUpdate({ tools: { auto_install: false } }, f.installer)).needed, false)
  let delay, calls = 0
  const schedule = (fn, ms) => { calls++; delay = ms; return { unref() {} } }
  await scheduleBBDownStartupUpdate(f.config, { installer: f.installer, schedule })
  assert.ok(delay > 290000 && delay <= 300000)
  assert.equal(f.urls.length, 0)
  await scheduleBBDownStartupUpdate(f.config, { installer: f.installer, schedule })
  assert.equal(calls, 1)
})
