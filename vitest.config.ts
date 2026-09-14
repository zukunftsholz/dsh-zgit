/**
 * Vitest config for dsh_zerogit. Tests run against the *installed* DSH
 * profile packages ($DSH_HOME/profiles/node_modules) — the exact runtime the
 * desktop app resolves peers from — rather than npm-published versions.
 * When the profile cannot satisfy the suite's imports (CI, fresh clone, or a
 * profile that pruned a package), the alias falls back to the project's own
 * node_modules (@deepseek-ai/* installed as dev deps).
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { defineConfig } from 'vitest/config'

const dshHome = process.env.DSH_HOME ?? `${process.env.USERPROFILE ?? process.env.HOME ?? ''}/.dsh`
const profileModules = join(dshHome, 'profiles', 'node_modules', '@deepseek-ai')
const localModules = join(process.cwd(), 'node_modules', '@deepseek-ai')

// Every `@deepseek-ai/*` import in tests/ resolves through one alias entry, so
// the profile has to carry all of them. A profile prunes packages the app does
// not load eagerly into hashed directories (`cordis` -> `.cordis-XsN1tw2c`),
// which leaves `dsh-tools` present and `cordis` missing — the alias would then
// fail the suite outright. Require the full set before preferring the profile.
const required = ['cordis', 'dsh-llm', 'dsh-system-prompt', 'dsh-tools']
const profileUsable = required.every((name) => existsSync(join(profileModules, name)))
const aliasTarget = profileUsable ? profileModules : localModules

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
