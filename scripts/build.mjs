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
    let result
    try {
      result = spawnSync(bin, ['scripts/build.sh'], { stdio: 'inherit' })
    } catch {
      continue // try the next candidate
    }
    if (result.error && result.error.code === 'ENOENT') continue
    if (result.status === 0) process.exit(0)
    // Bash exists but build.sh did not succeed — either a genuine build
    // failure or a broken shell (e.g. a sandboxed Git Bash that cannot
    // create signal pipes and crashes). Warn and fall through to the plain
    // local tsc build below: it compiles the same tsconfig, so genuine
    // compile errors surface again there instead of being masked.
    console.warn(`build: ${bin} scripts/build.sh exited with ${result.status ?? result.error ?? 'unknown error'} — falling back to local tsc`)
    return false
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