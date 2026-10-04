import { libraryView } from '../utils/library'

/** Main compared with each service, per collection, with the rows of `?collection=` (or the first collection). */
export default defineEventHandler((event) => {
  const { collection } = getQuery(event)
  return libraryView(typeof collection === 'string' ? collection : undefined)
})
