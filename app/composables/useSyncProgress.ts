import type { RunProgress } from '~~/shared/types'

/** Live sync progress over server-sent events. */
export function useSyncProgress(onFinished: () => void) {
  const progress = ref<RunProgress | null>(null)
  let source: EventSource | null = null

  onMounted(() => {
    source = new EventSource('/api/sync/events')
    source.onmessage = (event) => {
      const next = JSON.parse(event.data) as RunProgress
      const wasRunning = progress.value?.running
      progress.value = next
      if (wasRunning && !next.running) onFinished()
    }
  })
  onBeforeUnmount(() => source?.close())

  return progress
}
