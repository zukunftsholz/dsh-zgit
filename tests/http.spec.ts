import { afterEach, describe, expect, it } from 'vitest'
import {
  assertPublicUrl,
  httpBytes,
  isPrivateHostname,
  isPrivateUrl,
  privateBypass,
  setFetchImpl,
} from '../src/http.ts'
import { HttpError } from '../src/errors.ts'
import { isRateLimitError } from '../src/forge.ts'

afterEach(() => {
  setFetchImpl(globalThis.fetch.bind(globalThis) as typeof fetch)
})

describe('isPrivateHostname', () => {
  it.each([
    'localhost',
    'LOCALHOST',
    '127.0.0.1',
    '127.1.2.3',
    '10.0.0.5',
    '192.168.1.1',
    '172.16.0.1',
    '172.31.255.255',
    '169.254.10.20',
    '100.64.0.1',
    '::1',
    '[::1]',
    '0.0.0.0',
    'metadata.google.internal',
    'printer.local',
    'db.internal',
  ])('treats %s as private', host => {
    expect(isPrivateHostname(host)).toBe(true)
  })

  it.each([
    // Alternative IPv4 encodings of 127.0.0.1 must not bypass the guard.
    '2130706433',
    '0x7f000001',
    '0x7f.0.0.1',
    '0177.0.0.1',
    '::ffff:127.0.0.1',
  ])('treats encoded loopback %s as private', host => {
    expect(isPrivateHostname(host)).toBe(true)
  })

  it('treats 172.32.x.x as public (outside 172.16/12)', () => {
    expect(isPrivateHostname('172.32.0.1')).toBe(false)
  })

  it.each([
    'github.com',
    'codeload.github.com',
    'raw.githubusercontent.com',
    'objects.example',
    'mirror.example',
    '8.8.8.8',
    '1.1.1.1',
  ])('treats %s as public', host => {
    expect(isPrivateHostname(host)).toBe(false)
  })
})

describe('assertPublicUrl / privateBypass', () => {
  it('blocks private URLs unless bypassed', () => {
    expect(() => assertPublicUrl('http://127.0.0.1:3000/x.tar.gz')).toThrow(/SSRF guard/)
    expect(() => assertPublicUrl('http://127.0.0.1:3000/x.tar.gz', true)).not.toThrow()
    expect(() => assertPublicUrl('https://codeload.github.com/o/r/tar.gz/main')).not.toThrow()
  })

  it('rejects invalid URLs', () => {
    expect(() => assertPublicUrl('not a url')).toThrow(/invalid URL/)
  })

  it('privateBypass mirrors isPrivateUrl', () => {
    expect(privateBypass('http://localhost:3000/a')).toBe(true)
    expect(privateBypass('https://github.com/o/r')).toBe(false)
    expect(isPrivateUrl('not a url')).toBe(false)
  })
})

describe('httpBytes SSRF guard', () => {
  it('refuses private URLs without calling fetch', async () => {
    let called = false
    setFetchImpl(async () => {
      called = true
      return new Response('x', { status: 200 })
    })
    await expect(httpBytes('http://127.0.0.1/secret')).rejects.toThrow(/SSRF guard/)
    expect(called).toBe(false)
  })

  it('allows private URLs with allowPrivate for local fixtures', async () => {
    setFetchImpl(async () => new Response(new Uint8Array([1, 2]), { status: 200 }))
    const result = await httpBytes('http://127.0.0.1/pkg.tgz', { allowPrivate: true })
    expect(result.bytes).toHaveLength(2)
  })

  it('carries response headers on HttpError', async () => {
    setFetchImpl(async () => new Response('limited', {
      status: 429,
      headers: { 'x-ratelimit-remaining': '0', 'retry-after': '60' },
    }))
    const error = await httpBytes('https://api.github.com/rate_limit').catch(error => error)
    expect(error).toBeInstanceOf(HttpError)
    expect((error as HttpError).headers['x-ratelimit-remaining']).toBe('0')
    expect((error as HttpError).headers['retry-after']).toBe('60')
  })
})

describe('isRateLimitError', () => {
  it('treats any 429 as rate-limited (no message match needed)', () => {
    expect(isRateLimitError(new HttpError('https://api.github.com/x', 429, 'too many requests', {}))).toBe(true)
  })

  it('treats 403 with rate-limit headers as rate-limited', () => {
    expect(isRateLimitError(new HttpError('https://api.github.com/x', 403, 'forbidden', { 'x-ratelimit-remaining': '0' }))).toBe(true)
    expect(isRateLimitError(new HttpError('https://api.github.com/x', 403, 'forbidden', { 'retry-after': '30' }))).toBe(true)
  })

  it('keeps the message fallback for mocked fixtures', () => {
    expect(isRateLimitError(new HttpError('https://api.github.com/x', 403, 'API rate limit exceeded', {}))).toBe(true)
  })

  it('does not mistake plain 403s for rate limits', () => {
    expect(isRateLimitError(new HttpError('https://api.github.com/x', 403, 'forbidden', {}))).toBe(false)
    expect(isRateLimitError(new HttpError('https://api.github.com/x', 404, 'not found', {}))).toBe(false)
    expect(isRateLimitError(new Error('boom'))).toBe(false)
  })
})
