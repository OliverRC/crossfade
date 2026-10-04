import { getProgress, onProgress } from '../jobs/runner'

export default defineEventHandler(async (event) => {
  const stream = createEventStream(event)
  const send = (p: unknown) => stream.push(JSON.stringify(p))
  const off = onProgress(send)
  stream.onClosed(async () => { off(); await stream.close() })
  send(getProgress())
  return stream.send()
})
