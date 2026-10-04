import { stagedView } from '../../utils/staging'

/** What the next push to each service would do: its staged adds and removals per collection. */
export default defineEventHandler(() => stagedView())
