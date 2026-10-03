/** A clock that ticks every `intervalMs`, for countdowns. */
export function useNow(intervalMs = 30_000) {
  const now = ref(Date.now())
  let timer: ReturnType<typeof setInterval> | undefined
  onMounted(() => { timer = setInterval(() => { now.value = Date.now() }, intervalMs) })
  onBeforeUnmount(() => clearInterval(timer))
  return now
}

/** "5 h 12 min", "8 min", "under a minute". */
export function formatSpan(ms: number): string {
  const minutes = Math.round(ms / 60_000)
  if (minutes < 1) return 'under a minute'
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return h ? `${h} h${m ? ` ${m} min` : ''}` : `${m} min`
}

/** "14:20 UTC", or "Sat 14:20 UTC" when it is not today. */
export function formatWhen(iso: string): string {
  const d = new Date(iso)
  const time = `${d.toISOString().slice(11, 16)} UTC`
  return d.toISOString().slice(0, 10) === new Date().toISOString().slice(0, 10) ? time : `${d.toUTCString().slice(0, 3)} ${time}`
}
