/**
 * Workspace confinement: every path the tools accept is resolved inside the
 * deployment's workspace root, mirroring the workspace-write sandbox stance.
 * @module dsh-zgit/fs-util
 */

import { isAbsolute, relative, resolve, sep } from 'node:path'
import { PathError } from './errors.ts'

/** A confined workspace handle. */
export interface Workspace {
  /** Absolute, normalized workspace root. */
  readonly root: string
  /** Resolve a user-supplied path inside the root; throws PathError outside. */
  resolve(input: string): string
  /** Render an absolute path as a workspace-relative display path. */
  display(abs: string): string
}

/** Create a workspace handle; the root itself is normalized to an absolute path. */
export function createWorkspace(root: string): Workspace {
  const absoluteRoot = isAbsolute(root) ? root : resolve(root)
  const resolvePath = (input: string): string => {
    const candidate = isAbsolute(input) ? input : resolve(absoluteRoot, input)
    if (candidate !== absoluteRoot && !candidate.startsWith(`${absoluteRoot}${sep}`)) {
      throw new PathError(`path "${input}" is outside the workspace root "${absoluteRoot}"`)
    }
    return candidate
  }
  return {
    root: absoluteRoot,
    resolve: resolvePath,
    display: abs => {
      const rel = relative(absoluteRoot, abs)
      return rel.length === 0 || rel.startsWith('..') ? abs : rel
    },
  }
}

/** Sanitize a directory name for use inside the workspace. */
export function safeDirName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._@-]+/g, '-').replace(/^-+|-+$/g, '')
  return cleaned.length > 0 ? cleaned : 'checkout'
}
