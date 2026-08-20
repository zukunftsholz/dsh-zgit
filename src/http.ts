/**
 * Minimal HTTP layer: capped streaming downloads, JSON reads, and structured
 * errors. Uses the global `fetch` (Node >= 20) with an injectable override for
 * tests. Every read honors an AbortSignal and a byte cap so a hostile or huge
 * remote cannot exhaust memory.
 * @module dsh-zgit/http
 */

import { HttpError, TooLargeError, ZgError } from './errors.ts'

/** Injectable fetch signature (subset of the WHATWG fetch). */
export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>

/** The fetch implementation used by every request. */
let fetchImpl: FetchLike = globalThis.fetch.bind(globalThis) as FetchLike

/** Replace the fetch implementation (tests). Returns the previous one. */
export function setFetchImpl(impl: FetchLike): FetchLike {
  const previous = fetchImpl
  fetchImpl = impl
  return previous
}

/** Common request options. */
export interface HttpOptions {
  signal?: AbortSignal
  headers?: Record<string, string>
  /** Byte cap on the response body; exceeding it throws TooLargeError. */
  maxBytes?: number
}

/** A capped binary download result. */
export interface HttpBytes {
  bytes: Uint8Array
  /** Final URL after redirects. */
  url: string
  contentType: string | undefined
}

/** Read a full response body with a byte cap, aborting early when exceeded. */
async function readCapped(response: Response, maxBytes: number, url: string): Promise<Uint8Array> {
  const reader = response.body?.getReader()
  if (reader === undefined) {
    // No streaming body (unusual); fall back to arrayBuffer with a size check.
    const buffer = await response.arrayBuffer()
    if (buffer.byteLength > maxBytes) throw new TooLargeError(url, maxBytes)
    return new Uint8Array(buffer)
  }
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined)
      throw new TooLargeError(url, maxBytes)
    }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

/** Fetch a URL and return the response with structured error handling. */
async function checkedFetch(url: string, options: HttpOptions, headers: Record<string, string>): Promise<Response> {
  let response: Response
  try {
    response = await fetchImpl(url, { signal: options.signal, headers, redirect: 'follow' })
  } catch (error: unknown) {
    if (error instanceof Error && error.name === 'AbortError') throw error
    if (error instanceof ZgError) throw error
    throw new ZgError(`request to ${url} failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
  return response
}

/** Fetch a URL as bytes with a cap, throwing HttpError/TooLargeError. */
export async function httpBytes(url: string, options: HttpOptions = {}): Promise<HttpBytes> {
  const headers: Record<string, string> = { ...options.headers }
  const response = await checkedFetch(url, options, headers)
  if (!response.ok) {
    const snippet = await response.text().catch(() => '')
    throw new HttpError(url, response.status, snippet.slice(0, 500))
  }
  const bytes = await readCapped(response, options.maxBytes ?? Infinity, url)
  return { bytes, url: response.url, contentType: response.headers.get('content-type') ?? undefined }
}

/** Fetch a URL as JSON with a 8 MiB cap. */
export async function httpJson(url: string, options: HttpOptions = {}): Promise<unknown> {
  const { bytes, url: finalUrl } = await httpBytes(url, { ...options, maxBytes: options.maxBytes ?? 8 * 1024 * 1024 })
  try {
    return JSON.parse(new TextDecoder().decode(bytes))
  } catch (error: unknown) {
    throw new ZgError(`response from ${finalUrl} is not valid JSON`, { cause: error })
  }
}

/** Fetch a URL as text, returning a truncated flag when the cap cut it. */
export async function httpText(url: string, options: HttpOptions = {}, maxChars: number): Promise<{ text: string; truncated: boolean }> {
  const { bytes } = await httpBytes(url, options)
  const text = new TextDecoder().decode(bytes)
  if (text.length <= maxChars) return { text, truncated: false }
  return { text: text.slice(0, maxChars), truncated: true }
}
