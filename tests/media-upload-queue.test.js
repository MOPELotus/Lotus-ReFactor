import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { setTimeout as delay } from "node:timers/promises"
import { sendMediaFile } from "../services/media/files.js"

function gate() {
  const { promise, resolve } = Promise.withResolvers()
  return { promise, resolve }
}
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lotus-upload-queue-"))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const files = []
  for (const [i, contents] of ['same-video', 'same-video', 'different-video'].entries()) {
    const dir = path.join(root, `task-${i}`)
    await fs.mkdir(dir)
    const file = path.join(dir, 'video-BV123456-P1-123.mp4')
    await fs.writeFile(file, contents)
    files.push(file)
  }
  return files
}
const config = { video_size_limit_mb: 0.000001, file_name: '原标题：100% 中文 视频.mp4' }

test('same content in independent tasks waits, while different contents and bots send concurrently without renaming', { timeout: 5000 }, async t => {
  const files = await fixture(t)
  const entered = gate(), release = gate(), otherContent = gate(), otherBot = gate()
  let active = false, secondStarted = false
  const received = []
  const event = (self_id, group_id, receive) => ({ self_id, group_id, isGroup: true, group: { sendFile: receive } })
  const receive = async (file, name, first) => {
    assert.equal(active, false, 'QQ must not read an internal cache while another identical upload overwrites it')
    active = true
    received.push(name)
    assert.equal(await fs.readFile(file, 'utf8'), 'same-video')
    if (first) { entered.resolve(); await release.promise }
    else { secondStarted = true }
    await fs.access(file)
    active = false
  }
  const first = sendMediaFile(event(101, 1, (f, n) => receive(f, n, true)), files[0], config)
  const pending = [first]
  try {
    await entered.promise
    pending.push(sendMediaFile(event(101, 2, (f, n) => receive(f, n, false)), files[1], config))
    pending.push(sendMediaFile(event(101, 3, async (file, name) => {
      assert.equal(await fs.readFile(file, 'utf8'), 'different-video')
      assert.equal(name, config.file_name)
      otherContent.resolve()
    }), files[2], config))
    pending.push(sendMediaFile(event(202, 4, async (file, name) => {
      assert.equal(await fs.readFile(file, 'utf8'), 'same-video')
      assert.equal(name, config.file_name)
      otherBot.resolve()
    }), files[1], config))
    await Promise.all([otherContent.promise, otherBot.promise])
    await delay(20)
    assert.equal(secondStarted, false)
    release.resolve()
    await Promise.all(pending)
    assert.equal(secondStarted, true)
    assert.deepEqual(received, [config.file_name, config.file_name])
    for (const file of files) await fs.access(file)
  } finally { release.resolve(); await Promise.allSettled(pending) }
})

test('a failed upload releases the same-content queue and a later request can send again', { timeout: 5000 }, async t => {
  const files = await fixture(t)
  const entered = gate(), release = gate()
  const seen = []
  const event = callback => ({ bot: { uin: 303 }, isGroup: true, group: { sendFile: callback } })
  const failed = sendMediaFile(event(async () => {
    entered.resolve()
    await release.promise
    throw new Error('rich media transfer failed')
  }), files[0], config)
  const failure = assert.rejects(failed, /rich media transfer failed/)
  const pending = [failure]
  try {
    await entered.promise
    pending.push(sendMediaFile(event(async (file, name) => {
      seen.push(name)
      assert.equal(await fs.readFile(file, 'utf8'), 'same-video')
    }), files[1], config))
    release.resolve()
    await Promise.all(pending)
    await sendMediaFile(event(async (file, name) => seen.push(name)), files[0], config)
    assert.deepEqual(seen, [config.file_name, config.file_name])
  } finally { release.resolve(); await Promise.allSettled(pending) }
})
