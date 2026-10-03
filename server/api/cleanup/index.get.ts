import { cleanupView } from '../../jobs/cleanup'

/** Duplicate and empty playlists from the latest full fetch, plus the latest cleanup's progress. */
export default defineEventHandler(() => cleanupView())
