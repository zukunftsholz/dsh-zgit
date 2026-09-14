/**
 * Workspace confinement: every path the tools accept is resolved inside the
 * deployment's workspace root, mirroring the workspace-write sandbox stance.
 * @module dsh-zgit/fs-util
 */
/** A confined workspace handle. */
export interface Workspace {
    /** Absolute, normalized workspace root. */
    readonly root: string;
    /** Resolve a user-supplied path inside the root; throws PathError outside. */
    resolve(input: string): string;
    /** Render an absolute path as a workspace-relative display path. */
    display(abs: string): string;
}
/** Create a workspace handle; the root itself is normalized to an absolute path. */
export declare function createWorkspace(root: string): Workspace;
/** Sanitize a directory name for use inside the workspace. */
export declare function safeDirName(name: string): string;
//# sourceMappingURL=fs-util.d.ts.map