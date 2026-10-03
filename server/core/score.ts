// Fuzzy match scoring (plan: "Scoring"). Pure functions, no I/O.
import type { ProviderTrack } from '../../shared/types'
import { normaliseText, splitTitle, versionKind } from './normalise'

export const REVIEW_FLOOR = 0.6

export interface ScoreBreakdown {
  score: number
  title: number
  artist: number
  duration: number
  versionMismatch: boolean
  explicitMismatch: boolean
}

function dice<T>(a: Set<T>, b: Set<T>): number {
  if (!a.size && !b.size) return 1
  if (!a.size || !b.size) return 0
  let common = 0
  for (const x of a) if (b.has(x)) common++
  return (2 * common) / (a.size + b.size)
}

function bigrams(value: string): Set<string> {
  const s = value.replace(/\s/g, '')
  const out = new Set<string>()
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2))
  if (s.length === 1) out.add(s)
  return out
}

/** Token-set similarity, falling back to character bigrams so unspaced scripts (CJK) still compare. */
export function similarity(a: string, b: string): number {
  if (a === b) return 1
  const tokens = dice(new Set(a.split(' ').filter(Boolean)), new Set(b.split(' ').filter(Boolean)))
  return Math.max(tokens, dice(bigrams(a), bigrams(b)))
}

export function durationScore(aMs: number, bMs: number): number {
  const diff = Math.abs(aMs - bMs) / 1000
  if (diff <= 2) return 1
  if (diff >= 10) return 0
  return 1 - (diff - 2) / 8
}

export function scoreMatch(source: ProviderTrack, candidate: ProviderTrack): ScoreBreakdown {
  const s = splitTitle(source.title, source.version)
  const c = splitTitle(candidate.title, candidate.version)

  const title = similarity(s.base, c.base)
  const artistsOf = (t: ProviderTrack, featured: string[]) =>
    [...new Set([...t.artists.map(normaliseText), ...featured])].sort().join(' ')
  const artist = similarity(artistsOf(source, s.featured), artistsOf(candidate, c.featured))
  const duration = durationScore(source.durationMs, candidate.durationMs)

  const versionMismatch = versionKind(s.version) !== versionKind(c.version)
  const explicitMismatch = source.explicit !== candidate.explicit

  let score = 0.45 * title + 0.35 * artist + 0.2 * duration
  if (explicitMismatch) score -= 0.05
  if (versionMismatch) score = Math.min(score, REVIEW_FLOOR - 0.01)
  score = Math.round(Math.max(0, Math.min(1, score)) * 100) / 100

  return { score, title, artist, duration, versionMismatch, explicitMismatch }
}

export function bestCandidate(source: ProviderTrack, candidates: ProviderTrack[]) {
  let best: { track: ProviderTrack, breakdown: ScoreBreakdown } | null = null
  for (const track of candidates) {
    const breakdown = scoreMatch(source, track)
    if (!best || breakdown.score > best.breakdown.score) best = { track, breakdown }
  }
  return best
}

/**
 * Several target tracks share the source's ISRC (same recording, different releases).
 * Any is correct; prefer the same album, then the same explicit flag, then the closest duration.
 */
export function pickIsrcResult(source: ProviderTrack, results: ProviderTrack[]): ProviderTrack | null {
  if (!results.length) return null
  const album = normaliseText(source.album)
  return [...results].sort((a, b) =>
    Number(normaliseText(b.album) === album) - Number(normaliseText(a.album) === album)
    || Number(b.explicit === source.explicit) - Number(a.explicit === source.explicit)
    || Math.abs(a.durationMs - source.durationMs) - Math.abs(b.durationMs - source.durationMs),
  )[0]!
}
