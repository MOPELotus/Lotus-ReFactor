import test from 'node:test'
import assert from 'node:assert/strict'
import { MihoyoClient } from '../core/mihoyo/client.js'

const url = 'https://api-takumi.mihoyo.com/auth/api/getCookieAccountInfoBySToken?stoken=secret-value&uid=123'

test('HTML error pages retain HTTP status and omit credentials', async () => {
  const client = new MihoyoClient({ fetch: async () => new Response('<html>Gone</html>', { status: 410, statusText: 'Gone' }) })
  await assert.rejects(client.requestJson(url), error => {
    assert.match(error.message, /http 410 Gone/)
    assert.match(error.message, /getCookieAccountInfoBySToken/)
    assert.doesNotMatch(error.message, /secret-value|stoken|uid=123/)
    return true
  })
})

test('invalid successful JSON reports status without query parameters', async () => {
  const client = new MihoyoClient({ fetch: async () => new Response('<html>error</html>', { status: 200 }) })
  await assert.rejects(client.requestJson(url), error => {
    assert.match(error.message, /invalid json response.*HTTP 200/)
    assert.doesNotMatch(error.message, /secret-value|stoken|uid=123/)
    return true
  })
})

test('valid API responses remain available on success and HTTP failure', async () => {
  const data = { retcode: -100, message: 'login expired' }
  const client = new MihoyoClient({ fetch: async () => Response.json(data) })
  assert.deepEqual(await client.requestJson(url), data)
  client.fetch = async () => Response.json(data, { status: 400 })
  await assert.rejects(client.requestJson(url), error => {
    assert.deepEqual(error.data, data)
    return true
  })
})
