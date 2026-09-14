/**
 * Minimal HTTP layer: capped streaming downloads, JSON reads, and structured
 * errors. Uses the global `fetch` (Node >= 20) with an injectable override for
 * tests. Every read honors an AbortSignal and a byte cap so a hostile or huge
 * remote cannot exhaust memory.
 * @module dsh-zgit/http
 */
/** Injectable fetch signature (subset of the WHATWG fetch). */
export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;
/** Replace the fetch implementation (tests). Returns the previous one. */
export declare function setFetchImpl(impl: FetchLike): FetchLike;
/** Common request options. */
export interface HttpOptions {
    signal?: AbortSignal;
    headers?: Record<string, string>;
    /** Byte cap on the response body; exceeding it throws TooLargeError. */
    maxBytes?: number;
    /** Allow private/loopback hosts (for local e2e tests and self-hosted forges). */
    allowPrivate?: boolean;
}
/** A capped binary download result. */
export interface HttpBytes {
    bytes: Uint8Array;
    /** Final URL after redirects. */
    url: string;
    contentType: string | undefined;
}
/** Whether a hostname targets a private/loopback/link-local host (SSRF guard). */
export declare function isPrivateHostname(host: string): boolean;
/** Whether a URL targets a private host; invalid URLs return false (callers validate separately). */
export declare function isPrivateUrl(url: string): boolean;
/**
 * allowPrivate value for self-hosted forges / local e2e fixtures: bypass the
 * SSRF guard only when the target itself is private; public hosts always go
 * through the guard (which passes for them anyway).
 */
export declare function privateBypass(url: string): boolean;
export declare function assertPublicUrl(url: string, allowPrivate?: boolean): void;
/** Fetch a URL as bytes with a cap, throwing HttpError/TooLargeError. */
export declare function httpBytes(url: string, options?: HttpOptions): Promise<HttpBytes>;
/** Fetch a URL as JSON with a 8 MiB cap. */
export declare function httpJson(url: string, options?: HttpOptions): Promise<unknown>;
/** Fetch a URL as text, returning a truncated flag when the cap cut it. */
export declare function httpText(url: string, options: HttpOptions | undefined, maxChars: number): Promise<{
    text: string;
    truncated: boolean;
}>;
//# sourceMappingURL=http.d.ts.map