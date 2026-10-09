import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { spawnSync } from "node:child_process"
import { safeMediaName, sendMediaFile, packMediaFiles, runMediaProcess } from "../services/media/files.js"
import { prepareVideo } from "../services/media/video.js"
import { BilibiliService, buildBBDownArgs } from "../services/bilibili/service.js"

const specials = [
  '1金提升至300%!1个视频告诉你沃雅妮莎对公子提升有多大',
  '100%', '%20', '%2F', '%FF', '%E4%B8%AD', '#标签?query=1&x=2',
  `单引号' 双引号" 反引号\``, '$(echo injected); & | < > ! $ ^ ~',
  '括号() 方括号[] 花括号{}', '-leading-option', '..', '.', '... ', ' trailing. ',
  'slash/ backslash\\ colon: star* question?', '空 格\t换\n行\r',
  '中文【标题】《作品》！？', '❤️家庭👨‍👩‍👧‍👦旗帜🇨🇳肤色👍🏽', 'e\u0301组合字',
  '方向\u202e反转\u2066控制', '全角％＃＆！', 'con', 'NUL.txt', 'COM1', 'LPT9.mp4', 'COM¹',
  '汉'.repeat(300), '😀'.repeat(200), '👨‍👩‍👧‍👦'.repeat(40), 'a'.repeat(500), '\ud800坏代理\udfff',
]
const controls = [...Array.from({ length: 32 }, (_, i) => i), ...Array.from({ length: 33 }, (_, i) => i + 127)]
const punctuation = Array.from('!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~')
const matrix = [...specials, ...controls.map(code => `control${String.fromCharCode(code)}end`), ...punctuation.map(char => `title${char}end`)]
const setup = async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lotus-name-test-"))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  return dir
}

// Reproduce the two adapter steps seen in this machine's logs: an existing
// path becomes an unescaped file:// URI, then NapCat decodeURIComponent()s it.
async function consumeAsNapCat(file, expected) {
  const decoded = decodeURIComponent(`file://${file}`.slice(7))
  assert.equal(decoded, file, "传输路径不能被 URI 解码改写")
  assert.deepEqual(await fs.readFile(decoded), expected)
}

test(`${matrix.length} 类名称可创建文件，保留 UTF-8 和完整字素，避开系统保留名称`, async t => {
  const root = await setup(t)
  for (const [index, title] of matrix.entries()) {
    const name = safeMediaName(title)
    assert.ok(name.length)
    assert.ok(name.isWellFormed())
    assert.ok(Buffer.byteLength(name) <= 180, title)
    assert.doesNotMatch(name, /[\\/:*?"<>|\u0000-\u001f\u007f-\u009f]/)
    assert.doesNotMatch(name, /[ .]$/)
    assert.doesNotMatch(name, /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i)
    const dir = path.join(root, String(index)); await fs.mkdir(dir)
    await fs.writeFile(path.join(dir, `${name}-7681612993096177393.zip`), "content")
  }
  for (const cluster of ['👨‍👩‍👧‍👦', '🇨🇳', '👍🏽', 'e\u0301']) {
    const name = safeMediaName(cluster.repeat(100))
    assert.ok([...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(name)].every(item => item.segment === cluster.normalize('NFC')))
  }
})

test("特殊名称视频、图片、群文件和私聊文件均可被适配器解码，保留显示名称", async t => {
  const root = await setup(t)
  const previous = globalThis.segment
  globalThis.segment = { video: (file, name) => ({ type: "video", file, name }), image: (file, name) => ({ type: "image", file, name }) }
  t.after(() => { globalThis.segment = previous })
  const content = Buffer.from('same media bytes')
  for (const [index, title] of specials.entries()) {
    const parent = path.join(root, `目录 %20 # ${index}`); await fs.mkdir(parent)
    for (const [ext, route] of [['.mp4', 'video'], ['.png', 'image'], ['.zip', 'group'], ['.mp4', 'private']]) {
      const file = path.join(parent, `${safeMediaName(title)}${ext}`)
      await fs.writeFile(file, content)
      let sent
      const receive = async (target, name) => { await consumeAsNapCat(target, content); assert.equal(name, path.basename(file)); sent = target }
      const event = route === 'group' ? { isGroup: true, group: { sendFile: receive } }
        : route === 'private' ? { friend: { sendFile: receive } }
          : { reply: async message => { assert.equal(message.type, route); await receive(message.file, message.name) } }
      await sendMediaFile(event, file, { video_size_limit_mb: route === 'private' ? 0.000001 : 100 })
      assert.ok(sent)
      assert.deepEqual(await fs.readFile(file), content)
      if (sent !== file) await assert.rejects(fs.access(sent), { code: 'ENOENT' })
    }
    assert.deepEqual((await fs.readdir(parent)).filter(name => name.startsWith('.lotus-media-upload-')), [])
  }
})

test("传输别名等待发送完成后清理，失败同样清理且不删除原文件", async t => {
  const root = await setup(t)
  const file = path.join(root, '100%.zip'); await fs.writeFile(file, 'bytes')
  let finish, sent
  const e = { isGroup: true, group: { sendFile: async target => { sent = target; await new Promise(resolve => { finish = resolve }); await fs.access(target) } } }
  const pending = sendMediaFile(e, file)
  while (!finish) await new Promise(resolve => setTimeout(resolve, 1))
  await fs.access(sent); finish(); await pending
  await assert.rejects(fs.access(sent), { code: 'ENOENT' })
  await assert.rejects(sendMediaFile({ isGroup: true, group: { sendFile: async target => { sent = target; throw new Error('send rejected') } } }, file), /send rejected/)
  await assert.rejects(fs.access(sent), { code: 'ENOENT' })
  await fs.access(file)
})

test("BBDown 单P、多P均使用不含标题的独立文件模式，分P相同标题不冲突", async t => {
  const root = await setup(t)
  const args = await buildBBDownArgs('https://www.bilibili.com/video/BV1234567890', root)
  assert.equal(args[args.indexOf('--file-pattern') + 1], 'video-<bvid>-P<pageNumberWithZero>-<cid>')
  assert.equal(args[args.indexOf('--multi-file-pattern') + 1], 'video-<bvid>-P<pageNumberWithZero>-<cid>')
  const service = new BilibiliService({ tasksDir: root })
  service.getInfo = async () => ({ type: 'video', title: '300%! #标题', bvid: 'BV1234567890', duration: 1, pages: [{ page: 1, part: '同标题' }, { page: 2, part: '未下载的第二P' }, { page: 3, part: '同标题' }] })
  service.downloadWithBBDown = async (plan, config, dir) => {
    const files = [1, 3].map(page => path.join(dir, `video-BV1234567890-P${page}-123.mp4`))
    for (const file of files) await fs.writeFile(file, 'video')
    return files
  }
  const result = await service.download('BV1234567890', { multi_page_policy: 'all' })
  assert.deepEqual(Object.values(result.fileNames), ['P1 同标题.mp4', 'P3 同标题.mp4'])
  await service.releaseTask(result)
})

test("特殊名称实际通过 FFprobe、FFmpeg 转封装、ZIP 打包及读取", async t => {
  if (process.platform === 'win32') return t.skip('Unix zip integration; filename rules and send routes are covered above')
  for (const name of ['ffmpeg', 'ffprobe', 'zip', 'unzip']) if (spawnSync(name, ['-version']).error?.code === 'ENOENT') return t.skip(`${name} unavailable`)
  const root = await setup(t)
  const fixture = path.join(root, 'fixture.mkv')
  await runMediaProcess('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=32x32:r=10', '-t', '0.1', '-c:v', 'libx264', '-threads', '1', '-pix_fmt', 'yuv420p', fixture])
  for (const [index, title] of specials.entries()) {
    const dir = path.join(root, String(index)); await fs.mkdir(dir)
    const file = path.join(dir, `${safeMediaName(title)}.mkv`); await fs.copyFile(fixture, file)
    const video = await prepareVideo(file)
    assert.ok((await fs.stat(video.file)).size > 0)
    const target = path.join(dir, `${safeMediaName(title)}.zip`)
    await packMediaFiles([video.file], target)
    await runMediaProcess('unzip', ['-t', target])
  }
})

test("未清洗的历史文件和特殊扩展名发送时仍使用安全路径", async t => {
  const root = await setup(t)
  const names = ['raw%FF.zip', 'percent%20name.zip', 'hash#name.zip', 'video.mp4%FF', 'file.💖', '.hidden', '控制\n行.zip', "quote'`$().zip"]
  for (const name of names) {
    const file = path.join(root, name); await fs.writeFile(file, 'bytes')
    await sendMediaFile({ isGroup: true, group: { sendFile: async (target, displayName) => {
      assert.equal(displayName, name)
      await consumeAsNapCat(target, Buffer.from('bytes'))
      assert.doesNotMatch(target, /[%#\n`$']/)
    } } }, file)
    await fs.access(file)
  }
})
