/**
 * Workspace confinement: every path the tools accept is resolved inside the
 * deployment's workspace root, mirroring the workspace-write sandbox stance.
 * @module dsh-zgit/fs-util
 */
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { PathError } from "./errors.js";
/** Create a workspace handle; the root itself is normalized to an absolute path. */
export function createWorkspace(root) {
    const absoluteRoot = isAbsolute(root) ? root : resolve(root);
    const resolvePath = (input) => {
        const candidate = isAbsolute(input) ? input : resolve(absoluteRoot, input);
        if (candidate !== absoluteRoot && !candidate.startsWith(`${absoluteRoot}${sep}`)) {
            throw new PathError(`path "${input}" is outside the workspace root "${absoluteRoot}"`);
        }
        return candidate;
    };
    return {
        root: absoluteRoot,
        resolve: resolvePath,
        display: abs => {
            const rel = relative(absoluteRoot, abs);
            return rel.length === 0 || rel.startsWith('..') ? abs : rel;
        },
    };
}
/** Sanitize a directory name for use inside the workspace. */
export function safeDirName(name) {
    const cleaned = name.replace(/[^A-Za-z0-9._@-]+/g, '-').replace(/^-+|-+$/g, '');
    return cleaned.length > 0 ? cleaned : 'checkout';
}
//# sourceMappingURL=fs-util.js.map