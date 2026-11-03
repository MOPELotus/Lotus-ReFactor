import { parentPort, workerData } from "node:worker_threads"
import { setTimeout as sleep } from "node:timers/promises"
import { CaptchaInference } from "./inference.js"
import { GeetestChallenge } from "./geetest.js"

const inference = new CaptchaInference(workerData.modelDir)
parentPort.on("message", async ({ id, challenge, timeoutMs }) => {
  const started = Date.now(), signal = AbortSignal.timeout(timeoutMs)
  try {
    const protocol = new GeetestChallenge(challenge, { signal })
    const prepared = await protocol.prepare()
    let result
    if (prepared.validate) result = { data: { validate: prepared.validate, challenge: protocol.challenge } }
    else {
      const points = await inference.solve(prepared.image, prepared.type)
      await sleep(Math.max(0, 4000 - (Date.now() - started)), undefined, { signal })
      result = await protocol.verify(points)
    }
    parentPort.postMessage({ id, result })
  } catch (error) { parentPort.postMessage({ id, error: error.message }) }
})
