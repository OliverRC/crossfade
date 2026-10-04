import { DecisionError, resolveConflict } from '../../jobs/decisions'

/** Decide a conflict: keep the song in main, or remove it. */
export default defineEventHandler(async (event) => {
  const { resolution } = await readBody<{ resolution?: string }>(event) ?? {}
  if (resolution !== 'keep' && resolution !== 'remove') throw createError({ statusCode: 400, statusMessage: 'Choose keep or remove' })
  try {
    resolveConflict(Number(getRouterParam(event, 'id')), resolution)
    return { ok: true }
  } catch (error) {
    if (error instanceof DecisionError) throw createError({ statusCode: 409, statusMessage: error.message })
    throw error
  }
})
