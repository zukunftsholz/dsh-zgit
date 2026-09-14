/**
 * Error vocabulary for dsh-zgit. All operation failures are ZgError
 * instances (or subclasses) so tool handlers can present a stable message
 * without leaking stack traces.
 * @module dsh-zgit/errors
 */
/** Base error for every dsh-zgit failure. */
export declare class ZgError extends Error {
    constructor(message: string, options?: {
        cause?: unknown;
    });
}
/** A remote replied with a non-2xx status. */
export declare class HttpError extends ZgError {
    readonly status: number;
    readonly url: string;
    readonly headers: Record<string, string>;
    constructor(url: string, status: number, detail: string, headers?: Record<string, string>);
}
/** A download exceeded the configured byte cap. */
export declare class TooLargeError extends ZgError {
    readonly url: string;
    readonly limit: number;
    constructor(url: string, limit: number);
}
/** A repo spec could not be parsed, or a forge operation is unsupported. */
export declare class RepoSpecError extends ZgError {
    constructor(message: string);
}
/** An archive (zip/tar) is malformed or unsafe. */
export declare class ArchiveError extends ZgError {
    constructor(message: string);
}
/** A local path is outside the confined workspace root. */
export declare class PathError extends ZgError {
    constructor(message: string);
}
//# sourceMappingURL=errors.d.ts.map