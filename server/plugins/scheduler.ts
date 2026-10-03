import { restoreSchedule } from '../jobs/runner'

// Runs after migrate.ts (plugins load alphabetically).
export default defineNitroPlugin(() => {
  restoreSchedule()
})
