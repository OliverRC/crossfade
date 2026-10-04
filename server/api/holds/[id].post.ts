import { DecisionError, resolveHold } from '../../jobs/decisions'

/** Decide a held collection: accept its removals, or keep or remove a playlist gone from the service. */
export default defineEventHandler(async (event) => {
  const { action } = await readBody<{ action?: string }>(event) ?? {}
  if (action !== 'accept' && action !== 'keep' && action !== 'remove') throw createError({ statusCode: 400, statusMessage: 'Choose accept, keep or remove' })
  try {
    resolveHold(Number(getRouterParam(event, 'id')), action)
    return { ok: true }
  } catch (error) {
    if (error instanceof DecisionError) throw createError({ statusCode: 409, statusMessage: error.message })
    throw error
  }
})
