import test from 'node:test'
import assert from 'node:assert/strict'
import { fetchImageBytes } from '../core/render/image.js'

test('render image enforces streamed byte limit and rejects empty/error responses', async () => {
  const fetch = async () => new Response(new Uint8Array([1, 2, 3]))
  assert.deepEqual(await fetchImageBytes('https://example.test/image', { fetch }), Buffer.from([1, 2, 3]))
  await assert.rejects(fetchImageBytes('https://example.test/image', { fetch, maxBytes: 2 }), /大小限制/)
  await assert.rejects(fetchImageBytes('https://example.test/image', { fetch: async () => new Response('') }), /为空/)
  await assert.rejects(fetchImageBytes('https://example.test/image', { fetch: async () => new Response('', { status: 403 }) }), /HTTP 403/)
})

test('render image timeout covers response headers and streamed body', async () => {
  const pending = signal => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
  await assert.rejects(fetchImageBytes('https://example.test/image', {
    timeoutMs: 20, fetch: async (_url, { signal }) => pending(signal),
  }), /下载超时/)
  await assert.rejects(fetchImageBytes('https://example.test/image', {
    timeoutMs: 20, fetch: async (_url, { signal }) => ({ ok: true, headers: new Headers(), body: {
      async *[Symbol.asyncIterator]() { yield new Uint8Array([1]); await pending(signal) },
    } }),
  }), /下载超时/)
})

test('archive titles leave room for IDs/extensions and never split Unicode', async () => {
  const { safeMediaName } = await import('../services/media/files.js')
  for (const title of ['汉'.repeat(200), '😀'.repeat(200), 'a'.repeat(500)]) {
    const safe = safeMediaName(title)
    assert.ok(Buffer.byteLength(safe + '-7681612993096177393.zip') < 255)
    assert.equal(safe.includes('\uFFFD'), false)
  }
})
