// Usage: pnpm hash-password '<password>'  → prints a value for APP_PASSWORD_HASH
import { hashAppPassword } from '../server/utils/password.ts'

const password = process.argv[2]
if (!password) {
  console.error("Usage: pnpm hash-password '<password>'")
  process.exit(1)
}
console.log(await hashAppPassword(password))
