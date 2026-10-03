import { PROVIDERS } from '../../../shared/types'
import { startSync } from '../../jobs/runner'
import { getAccount } from '../../utils/accounts'

export default defineEventHandler(() => {
  const missing = PROVIDERS.filter(p => { const a = getAccount(p); return !a || a.needsReconnect })
  if (missing.length) throw createError({ statusCode: 409, statusMessage: `Connect ${missing.join(' and ')} first` })
  const runId = startSync('manual')
  if (runId === null) throw createError({ statusCode: 409, statusMessage: 'A sync is already running' })
  return { runId }
})
