/** Parse an ISO 8601 duration such as "PT3M58S" or "PT1H2M3.5S" into milliseconds. */
export function isoDurationToMs(value: string | null | undefined): number {
  const m = value?.match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/)
  if (!m) return 0
  const [, d = '0', h = '0', min = '0', s = '0'] = m
  return Math.round(((Number(d) * 24 + Number(h)) * 3600 + Number(min) * 60 + Number(s)) * 1000)
}
