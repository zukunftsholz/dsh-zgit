/**
 * Minimal HTTP layer: capped streaming downloads, JSON reads, and structured
 * errors. Uses the global `fetch` (Node >= 20) with an injectable override for
 * tests. Every read honors an AbortSignal and a byte cap so a hostile or huge
 * remote cannot exhaust memory.
 * @module dsh-zgit/http
 */
import { HttpError, TooLargeError, ZgError } from "./errors.js";
/** The fetch implementation used by every request. */
let fetchImpl = globalThis.fetch.bind(globalThis);
/** Replace the fetch implementation (tests). Returns the previous one. */
export function setFetchImpl(impl) {
    const previous = fetchImpl;
    fetchImpl = impl;
    return previous;
}
/** Read a full response body with a byte cap, aborting early when exceeded. */
async function readCapped(response, maxBytes, url) {
    const reader = response.body?.getReader();
    if (reader === undefined) {
        const buffer = await response.arrayBuffer();
        if (buffer.byteLength > maxBytes)
            throw new TooLargeError(url, maxBytes);
        return new Uint8Array(buffer);
    }
    const chunks = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done)
            break;
        total += value.byteLength;
        if (total > maxBytes) {
            await reader.cancel().catch(() => undefined);
            throw new TooLargeError(url, maxBytes);
        }
        chunks.push(value);
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return out;
}
/** Parse one IPv4 octet that may be decimal, octal (`0177`), or hex (`0x7f`). */
function parseIpPart(part) {
    let text = part.trim().toLowerCase();
    if (text.length === 0)
        return undefined;
    let base = 10;
    if (text.startsWith('0x')) {
        base = 16;
        text = text.slice(2);
        if (text.length === 0 || !/^[0-9a-f]+$/.test(text))
            return undefined;
    }
    else if (/^0[0-9]+$/.test(text)) {
        base = 8;
        if (!/^[0-7]+$/.test(text))
            return undefined;
    }
    else if (!/^[0-9]+$/.test(text)) {
        return undefined;
    }
    const value = parseInt(text, base);
    if (!Number.isSafeInteger(value) || value < 0 || value > 4294967295)
        return undefined;
    return value;
}
/** Normalize an IPv4-ish hostname to 4 octets; handles decimal/hex/octal parts. */
function normalizeIPv4(host) {
    // Single-integer form: http://2130706433 (= 127.0.0.1), http://0x7f000001, ...
    if (!host.includes('.') && !host.includes(':')) {
        const value = parseIpPart(host);
        if (value === undefined || value > 4294967295)
            return undefined;
        return [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255];
    }
    if (!/^[0-9a-fA-FxX.]+$/.test(host))
        return undefined;
    const parts = host.split('.');
    if (parts.length !== 4)
        return undefined;
    const octets = [];
    for (const part of parts) {
        const value = parseIpPart(part);
        if (value === undefined || value > 255)
            return undefined;
        octets.push(value);
    }
    return octets;
}
function isPrivateIPv4(octets) {
    const [a, b] = octets;
    if (a === 127)
        return true;
    if (a === 10)
        return true;
    if (a === 192 && b === 168)
        return true;
    if (a === 172 && b >= 16 && b <= 31)
        return true;
    if (a === 169 && b === 254)
        return true;
    // CGNAT shared space (RFC 6598) is not publicly routable.
    if (a === 100 && b >= 64 && b <= 127)
        return true;
    if (a === 0)
        return true;
    return false;
}
/** Whether a hostname targets a private/loopback/link-local host (SSRF guard). */
export function isPrivateHostname(host) {
    const h = host.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
    if (h.length === 0)
        return false;
    if (h === 'localhost' || h === 'metadata.google.internal')
        return true;
    if (h.endsWith('.local') || h.endsWith('.internal'))
        return true;
    // IPv6 (URL.hostname strips brackets): loopback, link-local, unique-local,
    // unspecified, or embedded-IPv4 forms like ::ffff:127.0.0.1.
    if (h.includes(':')) {
        if (h === '::1' || h === '::' || h === '0:0:0:0:0:0:0:1' || h === '0:0:0:0:0:0:0:0')
            return true;
        if (h.startsWith('fe80:') || h.startsWith('fec0:') || h.startsWith('fc') || h.startsWith('fd'))
            return true;
        const embedded = h.split(':').pop() ?? '';
        if (embedded.includes('.')) {
            const octets = normalizeIPv4(embedded);
            // Embedded private v4 (e.g. ::ffff:127.0.0.1) is private; any other
            // embedded dotted quad is treated as private to fail closed.
            if (octets === undefined || isPrivateIPv4(octets))
                return true;
        }
        // Global unicast (2000::/3) is public; every other v6 literal fails closed.
        const compact = h.replace(/:/g, '');
        if (/^[23][0-9a-f]/i.test(compact.slice(0, 2)))
            return false;
        return true;
    }
    const octets = normalizeIPv4(h);
    if (octets !== undefined)
        return isPrivateIPv4(octets);
    return false;
}
/** Whether a URL targets a private host; invalid URLs return false (callers validate separately). */
export function isPrivateUrl(url) {
    try {
        return isPrivateHostname(new URL(url).hostname);
    }
    catch {
        return false;
    }
}
/**
 * allowPrivate value for self-hosted forges / local e2e fixtures: bypass the
 * SSRF guard only when the target itself is private; public hosts always go
 * through the guard (which passes for them anyway).
 */
export function privateBypass(url) {
    return isPrivateUrl(url);
}
export function assertPublicUrl(url, allowPrivate = false) {
    let host;
    try {
        host = new URL(url).hostname;
    }
    catch {
        throw new ZgError(`invalid URL "${url}"`);
    }
    if (!allowPrivate && isPrivateHostname(host))
        throw new ZgError(`refusing private/local URL "${url}" (SSRF guard)`);
}
function collectHeaders(response) {
    const out = {};
    response.headers.forEach((v, k) => { out[k.toLowerCase()] = v; });
    return out;
}
/** Fetch a URL and return the response with structured error handling. */
async function checkedFetch(url, options, headers) {
    let response;
    try {
        response = await fetchImpl(url, { signal: options.signal, headers, redirect: 'follow' });
    }
    catch (error) {
        if (error instanceof Error && error.name === 'AbortError')
            throw error;
        if (error instanceof ZgError)
            throw error;
        throw new ZgError(`request to ${url} failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    return response;
}
/** Fetch a URL as bytes with a cap, throwing HttpError/TooLargeError. */
export async function httpBytes(url, options = {}) {
    assertPublicUrl(url, options.allowPrivate === true);
    const headers = { ...options.headers };
    const response = await checkedFetch(url, options, headers);
    if (!response.ok) {
        const snippet = await response.text().catch(() => '');
        throw new HttpError(url, response.status, snippet.slice(0, 500), collectHeaders(response));
    }
    if (response.url) {
        assertPublicUrl(response.url, options.allowPrivate === true);
    }
    const bytes = await readCapped(response, options.maxBytes ?? Infinity, url);
    return { bytes, url: response.url, contentType: response.headers.get('content-type') ?? undefined };
}
/** Fetch a URL as JSON with a 8 MiB cap. */
export async function httpJson(url, options = {}) {
    const { bytes, url: finalUrl } = await httpBytes(url, { ...options, maxBytes: options.maxBytes ?? 8 * 1024 * 1024 });
    try {
        return JSON.parse(new TextDecoder().decode(bytes));
    }
    catch (error) {
        throw new ZgError(`response from ${finalUrl} is not valid JSON`, { cause: error });
    }
}
/** Fetch a URL as text, returning a truncated flag when the cap cut it. */
export async function httpText(url, options = {}, maxChars) {
    const { bytes } = await httpBytes(url, options);
    const text = new TextDecoder().decode(bytes);
    if (text.length <= maxChars)
        return { text, truncated: false };
    return { text: text.slice(0, maxChars), truncated: true };
}
//# sourceMappingURL=http.js.map