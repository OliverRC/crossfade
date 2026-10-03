import { type CleanupSelection, startCleanup } from '../../jobs/cleanup'

/** Merge the chosen exact copies and remove the chosen empty playlists on Tidal. Runs in the background. */
export default defineEventHandler(async (event) => {
  const body = await readBody<Partial<CleanupSelection>>(event)
  const selection: CleanupSelection = {
    merges: Array.isArray(body?.merges) ? body.merges.filter(m => typeof m?.key === 'string' && typeof m?.keeperId === 'string') : [],
    empties: Array.isArray(body?.empties) ? body.empties.filter((k): k is string => typeof k === 'string') : [],
  }
  try {
    return startCleanup(selection)
  } catch (error) {
    throw createError({ statusCode: 409, statusMessage: (error as Error).message })
  }
})
