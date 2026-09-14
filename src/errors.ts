/**
 * Error vocabulary for dsh-zgit. All operation failures are ZgError
 * instances (or subclasses) so tool handlers can present a stable message
 * without leaking stack traces.
 * @module dsh-zgit/errors
 */

/** Base error for every dsh-zgit failure. */
export class ZgError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'ZgError'
  }
}

/** A remote replied with a non-2xx status. */
export class HttpError extends ZgError {
  readonly status: number
  readonly url: string
  readonly headers: Record<string, string>

  constructor(url: string, status: number, detail: string, headers: Record<string, string> = {}) {
    super(`HTTP ${status} from ${url}${detail.length > 0 ? `: ${detail}` : ''}`)
    this.name = 'HttpError'
    this.status = status
    this.url = url
    this.headers = headers
  }
}

/** A download exceeded the configured byte cap. */
export class TooLargeError extends ZgError {
  readonly url: string
  readonly limit: number

  constructor(url: string, limit: number) {
    super(`response from ${url} exceeds the ${limit}-byte limit`)
    this.name = 'TooLargeError'
    this.url = url
    this.limit = limit
  }
}

/** A repo spec could not be parsed, or a forge operation is unsupported. */
export class RepoSpecError extends ZgError {
  constructor(message: string) {
    super(message)
    this.name = 'RepoSpecError'
  }
}

/** An archive (zip/tar) is malformed or unsafe. */
export class ArchiveError extends ZgError {
  constructor(message: string) {
    super(message)
    this.name = 'ArchiveError'
  }
}

/** A local path is outside the confined workspace root. */
export class PathError extends ZgError {
  constructor(message: string) {
    super(message)
    this.name = 'PathError'
  }
}
