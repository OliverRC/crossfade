// Text normalisation for fuzzy matching. Pure functions, no I/O.

const VERSION_WORDS = /\b(remaster(ed)?|live|radio edit|edit|acoustic|unplugged|remix|rmx|mix|demo|instrumental|karaoke|version|mono|stereo|extended|single|re-?recorded|deluxe|bonus|session)\b/i
const FEATURING = /\b(feat\.?|ft\.?|featuring|with)\s+/i

export function normaliseText(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

export interface SplitTitle {
  base: string
  version: string | null
  featured: string[]
}

/** Separate a raw title into its base, version tag ("2011 Remaster", "Live") and featured artists. */
export function splitTitle(title: string, version: string | null = null): SplitTitle {
  const versions: string[] = version ? [version] : []
  const featured: string[] = []
  let base = title

  base = base.replace(/[([]([^)\]]*)[)\]]/g, (whole, inner: string) => {
    const feat = inner.match(FEATURING)
    if (feat && inner.trim().toLowerCase().startsWith(feat[0].trim().toLowerCase())) {
      featured.push(...splitArtists(inner.slice(feat.index! + feat[0].length)))
      return ' '
    }
    if (VERSION_WORDS.test(inner)) {
      versions.push(inner)
      return ' '
    }
    return whole
  })

  const dash = base.match(/\s[-–—]\s(.+)$/)
  if (dash && VERSION_WORDS.test(dash[1]!)) {
    versions.push(dash[1]!)
    base = base.slice(0, dash.index)
  }

  const bareFeat = base.match(/\s(feat\.?|ft\.?|featuring)\s+(.+)$/i)
  if (bareFeat) {
    featured.push(...splitArtists(bareFeat[2]!))
    base = base.slice(0, bareFeat.index)
  }

  return {
    base: normaliseText(base),
    version: versions.length ? normaliseText(versions.join(' ')) : null,
    featured: featured.map(normaliseText).filter(Boolean),
  }
}

function splitArtists(value: string): string[] {
  return value.split(/,|&|\band\b|\bx\b/i).map(s => s.trim()).filter(Boolean)
}

export type VersionKind = 'original' | 'live' | 'remix' | 'acoustic' | 'instrumental' | 'demo' | 'karaoke'

/** Coarse class of a version tag. Remasters, edits and mono/stereo count as the original recording. */
export function versionKind(version: string | null): VersionKind {
  if (!version) return 'original'
  if (/\blive\b/.test(version)) return 'live'
  if (/\b(remix|rmx|mix)\b/.test(version) && !/\bremaster/.test(version)) return 'remix'
  if (/\b(acoustic|unplugged)\b/.test(version)) return 'acoustic'
  if (/\binstrumental\b/.test(version)) return 'instrumental'
  if (/\bdemo\b/.test(version)) return 'demo'
  if (/\bkaraoke\b/.test(version)) return 'karaoke'
  return 'original'
}
