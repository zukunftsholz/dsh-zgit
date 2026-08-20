/**
 * Vitest config for dsh_zerogit. Tests run against the *installed* DSH
 * profile packages ($DSH_HOME/profiles/node_modules) — the exact runtime the
 * desktop app resolves peers from — rather than npm-published versions.
 * When no profile install exists (CI, fresh clone), the alias falls back to
 * the project's own node_modules (@deepseek-ai/* installed as peer deps).
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { defineConfig } from 'vitest/config'

const dshHome = process.env.DSH_HOME ?? `${process.env.USERPROFILE ?? process.env.HOME ?? ''}/.dsh`
const profileModules = join(dshHome, 'profiles', 'node_modules', '@deepseek-ai')
const localModules = join(process.cwd(), 'node_modules', '@deepseek-ai')
const aliasTarget = existsSync(join(profileModules, 'dsh-tools')) ? profileModules : localModules

export default defineConfig({
  resolve: {
    alias: {
      '@deepseek-ai': aliasTarget.replace(/\\/g, '/'),
    },
  },
  test: {
    include: ['tests/**/*.spec.ts'],
    environment: 'node',
    testTimeout: 20_000,
  },
})
