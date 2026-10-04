import { PROVIDERS, type ProviderId } from '../../../shared/types'
import { setStaged } from '../../utils/staging'

interface Body { staged?: boolean, collection?: string, track?: number, provider?: string, change?: string }

/**
 * Stage or unstage the changes matching a filter: one song on one service, a whole collection, every add for a
 * service, or everything. Only changes that exist right now are touched.
 */
export default defineEventHandler(async (event) => {
  const body = await readBody<Body>(event) ?? {}
  if (typeof body.staged !== 'boolean') throw createError({ statusCode: 400, statusMessage: 'Say whether to stage or unstage' })
  if (body.provider !== undefined && !PROVIDERS.includes(body.provider as ProviderId)) throw createError({ statusCode: 400, statusMessage: 'Unknown service' })
  if (body.change !== undefined && body.change !== 'add' && body.change !== 'remove') throw createError({ statusCode: 400, statusMessage: 'Change is add or remove' })
  if (body.track !== undefined && body.collection === undefined) throw createError({ statusCode: 400, statusMessage: 'A song is staged within a collection' })
  const changed = setStaged({
    collectionId: body.collection === undefined ? undefined : Number(body.collection),
    canonicalTrackId: body.track,
    provider: body.provider as ProviderId | undefined,
    change: body.change as 'add' | 'remove' | undefined,
  }, body.staged)
  return { changed }
})
