#!/usr/bin/env node
/**
 * Portable build entry: runs scripts/build.sh through a found bash (Git Bash
 * on Windows often lives outside PATH), falling back to a plain local tsc
 * build when no bash is available (CI, unusual setups). The DSH injector
 * pipeline calls scripts/build.sh directly and is unaffected.
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'

const GIT_BASH_CANDIDATES = [
  'C:/Program Files/Git/bin/bash.exe',
  'C:/Program Files/Git/usr/bin/bash.exe',
  'C:/Program Files (x86)/Git/bin/bash.exe',
]

function runBash() {
  const candidates = []
  if (process.env.BASH) candidates.push(process.env.BASH)
  candidates.push('bash')
  for (const bin of GIT_BASH_CANDIDATES) {
    if (existsSync(bin)) candidates.push(bin)
  }
  for (const bin of candidates) {
    try {
      const result = spawnSync(bin, ['scripts/build.sh'], { stdio: 'inherit' })
      if (result.error && result.error.code === 'ENOENT') continue
      process.exit(result.status ?? (result.error ? 1 : 0))
    } catch {
      // try the next candidate
    }
  }
  return false
}

if (runBash()) process.exit(0)

const localTsc = 'node_modules/typescript/bin/tsc'
if (!existsSync(localTsc)) {
  console.error('build: no bash and no node_modules/typescript — set DSH_CHECKOUT and run "bash scripts/build.sh"')
  process.exit(1)
}
const result = spawnSync(process.execPath, [localTsc, '-p', 'tsconfig.build.json'], { stdio: 'inherit' })
process.exit(result.status ?? 1)