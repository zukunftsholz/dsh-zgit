/**
 * Pure-Node archive extraction: tar.gz (ustar + GNU long names + pax) and zip
 * (central-directory, store + deflate, zip64, CRC32-verified), with traversal
 * and bomb guards. Zero dependencies: `node:zlib` does all compression work.
 * @module dsh-zgit/archive
 */

import { createGunzip, inflateRawSync, crc32 } from 'node:zlib'
import { Readable } from 'node:stream'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { ArchiveError } from './errors.ts'

export type ArchiveKind = 'tar.gz' | 'zip'

/** One normalized archive entry, ready for extraction. */
export interface ArchiveEntry {
  /** Sanitized relative path with '/' separators. */
  path: string
  kind: 'file' | 'dir'
  /** File content (files only). */
  data?: Uint8Array
  /** Hardlink target path (hardlinks only). */
  linkTarget?: string
  /** Symlink target string (symlinks only). */
  symlinkTarget?: string
}

/** Extraction options. */
export interface ExtractOptions {
  /** Absolute directory to extract into (created as needed). */
  targetDir: string
  /** Strip the single top-level folder (git-clone-like layout). */
  stripRoot: boolean
  /** Extract only entries under this repo-relative path prefix. */
  subdir: string | undefined
  /** Max entries accepted from the archive. */
  maxEntries: number
  /** Max total uncompressed bytes written. */
  maxTotalBytes: number
}

/** Extraction outcome. */
export interface ExtractSummary {
  files: number
  dirs: number
  totalBytes: number
  /** Symlink entries skipped (materializing them is unsafe/privileged). */
  symlinksSkipped: string[]
  hardlinksCopied: number
  /** The stripped top-level folder name, when stripRoot applied. */
  strippedRoot: string | undefined
}

/** Detect the archive kind from URL/extension or magic bytes. */
export function detectArchiveKind(url: string, bytes: Uint8Array): ArchiveKind {
  const lower = url.toLowerCase()
  if (lower.endsWith('.zip')) return 'zip'
  if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) return 'tar.gz'
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) return 'zip'
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) return 'tar.gz'
  throw new ArchiveError(`cannot detect archive format from "${url}" (not a zip or gzip stream)`)
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i

/** Sanitize one archive path: reject traversal, absolutes, and reserved names. */
export function sanitizeEntryPath(name: string): string {
  const normalized = name.replace(/\\/g, '/')
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) {
    throw new ArchiveError(`archive entry "${name}" is an absolute path`)
  }
  const parts = normalized.split('/')
  const out: string[] = []
  for (const part of parts) {
    if (part === '' || part === '.') continue
    if (part === '..') throw new ArchiveError(`archive entry "${name}" escapes the target directory`)
    if (WINDOWS_RESERVED.test(part)) throw new ArchiveError(`archive entry "${name}" uses a reserved Windows name`)
    out.push(part)
  }
  if (out.length === 0) throw new ArchiveError(`archive entry "${name}" is empty`)
  return out.join('/')
}

/** Gunzip with a hard cap on the decompressed size (bomb guard). */
async function gunzipCapped(bytes: Uint8Array, cap: number): Promise<Uint8Array> {
  return await new Promise<Uint8Array>((resolve, reject) => {
    const chunks: Uint8Array[] = []
    let total = 0
    const gunzip = createGunzip()
    gunzip.on('data', (chunk: Buffer) => {
      total += chunk.byteLength
      if (total > cap) {
        gunzip.destroy(new ArchiveError(`decompressed archive exceeds the ${cap}-byte limit`))
        return
      }
      chunks.push(new Uint8Array(chunk))
    })
    gunzip.on('end', () => {
      const out = new Uint8Array(total)
      let offset = 0
      for (const chunk of chunks) {
        out.set(chunk, offset)
        offset += chunk.byteLength
      }
      resolve(out)
    })
    gunzip.on('error', (error: Error) => reject(error instanceof ArchiveError ? error : new ArchiveError(`invalid gzip stream: ${error.message}`)))
    Readable.from([bytes]).pipe(gunzip)
  })
}

/* ── tar ─────────────────────────────────────────────────────────────────── */

/** Parse an octal (or GNU base-256) numeric field. */
function parseTarNumber(field: Uint8Array): number {
  if (field.length > 0 && (field[0]! & 0x80) !== 0) {
    // GNU base-256: big-endian twos-complement of (length - 1) bytes.
    let value = field[0]! & 0x7f
    for (let index = 1; index < field.length; index += 1) {
      value = value * 256 + field[index]!
    }
    return value
  }
  const text = new TextDecoder().decode(field).trim()
  if (text.length === 0) return 0
  const value = Number.parseInt(text, 8)
  return Number.isFinite(value) ? value : 0
}

/** Read a NUL-terminated string field. */
function readTarString(field: Uint8Array): string {
  const end = field.indexOf(0)
  return new TextDecoder().decode(field.slice(0, end === -1 ? field.length : end))
}

/** Parse pax record data (`len key=value\n` records). */
function parsePaxRecords(data: Uint8Array): Record<string, string> {
  const text = new TextDecoder().decode(data)
  const records: Record<string, string> = {}
  let offset = 0
  while (offset < text.length) {
    const space = text.indexOf(' ', offset)
    if (space === -1) break
    const length = Number.parseInt(text.slice(offset, space), 10)
    if (!Number.isFinite(length) || length <= 0 || offset + length > text.length) break
    const record = text.slice(offset + space + 1, offset + length - 1) // drop trailing \n
    const eq = record.indexOf('=')
    if (eq !== -1) records[record.slice(0, eq)] = record.slice(eq + 1)
    offset += length
  }
  return records
}

interface RawTarEntry {
  name: string
  linkName: string
  size: number
  typeflag: string
  data?: Uint8Array
}

/** Walk a decompressed tar stream, invoking onEntry for each file/dir/link. */
function walkTar(buffer: Uint8Array, cap: number, onEntry: (entry: RawTarEntry) => void): void {
  const BLOCK = 512
  let offset = 0
  let pendingPax: Record<string, string> | undefined
  let pendingLongName: string | undefined
  let pendingLongLink: string | undefined
  let entries = 0

  const readHeader = (at: number): Uint8Array | undefined => {
    if (at + BLOCK > buffer.length) return undefined
    const block = buffer.subarray(at, at + BLOCK)
    if (block.every(byte => byte === 0)) return undefined
    return block
  }

  for (;;) {
    const header = readHeader(offset)
    if (header === undefined) break
    const name = readTarString(header.subarray(0, 100))
    const prefix = readTarString(header.subarray(345, 345 + 155))
    const typeflag = String.fromCharCode(header[156] ?? 0x30)
    const size = parseTarNumber(header.subarray(124, 124 + 12))
    const linkName = readTarString(header.subarray(157, 157 + 100))
    const dataBlocks = Math.ceil(size / BLOCK)
    if (offset + BLOCK + dataBlocks * BLOCK > buffer.length) {
      throw new ArchiveError('tar stream is truncated')
    }
    const data = size > 0 ? buffer.subarray(offset + BLOCK, offset + BLOCK + dataBlocks * BLOCK).slice(0, size) : undefined
    offset += BLOCK + dataBlocks * BLOCK

    const fullName = prefix.length > 0 ? `${prefix}/${name}` : name
    let effectiveName = fullName
    let effectiveLink = linkName
    let effectiveSize = size

    if (typeflag === 'x') {
      // pax extended header: applies to the NEXT entry.
      pendingPax = { ...pendingPax, ...data === undefined ? {} : parsePaxRecords(data) }
      continue
    }
    if (typeflag === 'g') {
      // pax global header.
      pendingPax = { ...data === undefined ? {} : parsePaxRecords(data), ...pendingPax }
      continue
    }
    if (typeflag === 'L') {
      pendingLongName = data === undefined ? undefined : new TextDecoder().decode(data)
      continue
    }
    if (typeflag === 'K') {
      pendingLongLink = data === undefined ? undefined : new TextDecoder().decode(data)
      continue
    }

    if (pendingPax !== undefined) {
      if (pendingPax.path !== undefined) effectiveName = pendingPax.path
      if (pendingPax.linkpath !== undefined) effectiveLink = pendingPax.linkpath
      if (pendingPax.size !== undefined) effectiveSize = Number.parseInt(pendingPax.size, 10)
      pendingPax = undefined
    }
    if (pendingLongName !== undefined) {
      effectiveName = pendingLongName
      pendingLongName = undefined
    }
    if (pendingLongLink !== undefined) {
      effectiveLink = pendingLongLink
      pendingLongLink = undefined
    }

    if (typeflag === '0' || typeflag === '\0' || typeflag === '7' || typeflag === '') {
      entries += 1
      if (entries > cap) throw new ArchiveError(`archive has more than ${cap} entries`)
      onEntry({ name: effectiveName, linkName: effectiveLink, size: effectiveSize, typeflag, data: data ?? new Uint8Array(0) })
    } else if (typeflag === '5') {
      onEntry({ name: effectiveName, linkName: effectiveLink, size: 0, typeflag, data: undefined })
    } else if (typeflag === '2') {
      onEntry({ name: effectiveName, linkName: effectiveLink, size: 0, typeflag, data: undefined })
    } else if (typeflag === '1') {
      entries += 1
      if (entries > cap) throw new ArchiveError(`archive has more than ${cap} entries`)
      onEntry({ name: effectiveName, linkName: effectiveLink, size: 0, typeflag, data: undefined })
    }
    // Other types (char/block/fifo) are skipped.
  }
}

/** Extract a tar.gz archive. */
export async function extractTarGz(bytes: Uint8Array, options: ExtractOptions): Promise<ExtractSummary> {
  // Tar headers/padding add ~1 KiB per entry on top of the file bytes.
  const slack = options.maxEntries * 1024 + 64 * 1024
  const tar = await gunzipCapped(bytes, options.maxTotalBytes + slack)
  const raw: RawTarEntry[] = []
  walkTar(tar, options.maxEntries, entry => { raw.push(entry) })
  return extractEntries(raw, options)
}

/* ── zip ─────────────────────────────────────────────────────────────────── */

interface ZipEntry {
  name: string
  method: number
  compressedSize: number
  uncompressedSize: number
  crc: number
  localOffset: number
  isDir: boolean
}

/** Find the end-of-central-directory record, with zip64 support. */
function readZipEntries(buffer: Uint8Array): ZipEntry[] {
  const EOCD = 0x06054b50
  const ZIP64_EOCD = 0x06064b50
  const ZIP64_LOCATOR = 0x07064b50
  const CD_ENTRY = 0x02014b50
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)

  const u32 = (at: number): number => view.getUint32(at, true)
  const u64 = (at: number): number => Number(view.getBigUint64(at, true))

  // Scan backward for EOCD (its comment may be up to 64 KiB).
  const tail = Math.min(buffer.length, 65_557)
  let eocd = -1
  for (let at = buffer.length - 22; at >= buffer.length - tail; at -= 1) {
    if (u32(at) === EOCD) { eocd = at; break }
  }
  if (eocd === -1) throw new ArchiveError('zip archive has no end-of-central-directory record')

  let count = view.getUint16(eocd + 10, true)
  let cdSize = u32(eocd + 12)
  let cdOffset = u32(eocd + 16)
  let count64 = 0

  if (count === 0xffff || cdOffset === 0xffffffff || cdSize === 0xffffffff) {
    // Zip64: locator sits directly before the EOCD.
    const locator = eocd - 20
    if (locator >= 0 && u32(locator) === ZIP64_LOCATOR) {
      const zip64 = Number(view.getBigUint64(locator + 8, true))
      if (zip64 + 56 <= buffer.length && u32(zip64) === ZIP64_EOCD) {
        count64 = u64(zip64 + 32)
        cdSize = Number(view.getBigUint64(zip64 + 40, true))
        cdOffset = Number(view.getBigUint64(zip64 + 48, true))
      }
    }
  }

  if (count === 0xffff && count64 > 0) count = count64
  if (cdOffset + cdSize > buffer.length) throw new ArchiveError('zip central directory is out of bounds')

  const entries: ZipEntry[] = []
  let at = cdOffset
  for (let index = 0; index < count; index += 1) {
    if (at + 46 > buffer.length || u32(at) !== CD_ENTRY) throw new ArchiveError('zip central directory is malformed')
    const flags = u16(at + 8)
    const method = u16(at + 10)
    const crc = u32(at + 16)
    let compressedSize = u32(at + 20)
    let uncompressedSize = u32(at + 24)
    const nameLength = u16(at + 28)
    const extraLength = u16(at + 30)
    const commentLength = u16(at + 32)
    let localOffset = u32(at + 42)
    const name = new TextDecoder(flags & 0x800 ? 'utf-8' : 'utf-8').decode(buffer.subarray(at + 46, at + 46 + nameLength))

    // Zip64 extra field (0x0001) may override sizes/offset.
    const extra = buffer.subarray(at + 46 + nameLength, at + 46 + nameLength + extraLength)
    let extraAt = 0
    while (extraAt + 4 <= extra.length) {
      const id = u16At(extra, extraAt)
      const size = u16At(extra, extraAt + 2)
      const body = extra.subarray(extraAt + 4, extraAt + 4 + size)
      if (id === 0x0001) {
        let bodyAt = 0
        if (uncompressedSize === 0xffffffff) { uncompressedSize = Number(readU64(body, bodyAt)); bodyAt += 8 }
        if (compressedSize === 0xffffffff) { compressedSize = Number(readU64(body, bodyAt)); bodyAt += 8 }
        if (localOffset === 0xffffffff) { localOffset = Number(readU64(body, bodyAt)); bodyAt += 8 }
      }
      extraAt += 4 + size
    }

    entries.push({ name, method, compressedSize, uncompressedSize, crc, localOffset, isDir: name.endsWith('/') })
    at += 46 + nameLength + extraLength + commentLength
  }
  return entries

  function u16(at: number): number { return view.getUint16(at, true) }
  function u16At(bytes: Uint8Array, at: number): number {
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(at, true)
  }
  function readU64(bytes: Uint8Array, at: number): bigint {
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(at, true)
  }
}

/** Extract a zip archive (entries read directly from the downloaded bytes). */
export async function extractZip(bytes: Uint8Array, options: ExtractOptions): Promise<ExtractSummary> {
  const entries = readZipEntries(bytes)
  if (entries.length > options.maxEntries) {
    throw new ArchiveError(`archive has more than ${options.maxEntries} entries`)
  }
  const raw: RawTarEntry[] = []
  const LOCAL = 0x04034b50
  for (const entry of entries) {
    if (entry.localOffset + 30 > bytes.length) throw new ArchiveError(`zip entry "${entry.name}" points outside the archive`)
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    if (view.getUint32(entry.localOffset, true) !== LOCAL) {
      throw new ArchiveError(`zip entry "${entry.name}" has no local header`)
    }
    const nameLength = view.getUint16(entry.localOffset + 26, true)
    const extraLength = view.getUint16(entry.localOffset + 28, true)
    const dataStart = entry.localOffset + 30 + nameLength + extraLength
    if (dataStart + entry.compressedSize > bytes.length) throw new ArchiveError(`zip entry "${entry.name}" data is out of bounds`)
    const compressed = bytes.subarray(dataStart, dataStart + entry.compressedSize)
    let data: Uint8Array | undefined
    if (entry.isDir) {
      data = undefined
    } else if (entry.method === 0) {
      data = compressed
    } else if (entry.method === 8) {
      try {
        data = inflateRawSync(compressed, { maxOutputLength: entry.uncompressedSize })
      } catch (error: unknown) {
        throw new ArchiveError(`zip entry "${entry.name}" failed to inflate: ${error instanceof Error ? error.message : String(error)}`)
      }
      if (data.length !== entry.uncompressedSize) {
        throw new ArchiveError(`zip entry "${entry.name}" inflated to ${data.length} bytes, expected ${entry.uncompressedSize}`)
      }
    } else {
      throw new ArchiveError(`zip entry "${entry.name}" uses unsupported compression method ${entry.method}`)
    }
    if (data !== undefined) {
      if (data.length > entry.uncompressedSize) throw new ArchiveError(`zip entry "${entry.name}" exceeds its declared size`)
      if (crc32(data) !== entry.crc) throw new ArchiveError(`zip entry "${entry.name}" failed CRC32 verification`)
    }
    raw.push({
      name: entry.name,
      linkName: '',
      size: data?.length ?? 0,
      typeflag: entry.isDir ? '5' : '0',
      data,
    })
  }
  return extractEntries(raw, options)
}

/* ── shared extraction ───────────────────────────────────────────────────── */

/** Compute the common top-level folder, when every entry shares one. */
function commonRoot(names: string[]): string | undefined {
  if (names.length === 0) return undefined
  const first = names[0]!
  const slash = first.indexOf('/')
  if (slash === -1) return undefined
  const root = first.slice(0, slash)
  for (const name of names) {
    if (name === root || !name.startsWith(`${root}/`)) return undefined
  }
  return root
}

/** Extract normalized raw entries into the target directory. */
async function extractEntries(raw: RawTarEntry[], options: ExtractOptions): Promise<ExtractSummary> {
  const fileNames = raw.filter(entry => entry.typeflag !== '5').map(entry => entry.name)
  const strippedRoot = options.stripRoot ? commonRoot(fileNames) : undefined

  const summary: ExtractSummary = { files: 0, dirs: 0, totalBytes: 0, symlinksSkipped: [], hardlinksCopied: 0, strippedRoot }
  const seen = new Map<string, string>() // folded path -> real path
  const writtenFiles = new Map<string, string>() // folded archive path -> abs file path (hardlinks)
  let totalBytes = 0

  const strip = (name: string): string => {
    if (strippedRoot === undefined) return name
    return name.startsWith(`${strippedRoot}/`) ? name.slice(strippedRoot.length + 1) : name === strippedRoot ? '' : name
  }

  const fold = (path: string): string => path.toLowerCase()

  for (const entry of raw) {
    const stripped = strip(entry.name)
    if (stripped.length === 0) continue // the root folder itself
    if (options.subdir !== undefined) {
      if (stripped !== options.subdir && !stripped.startsWith(`${options.subdir}/`)) continue
    }
    const safePath = sanitizeEntryPath(stripped)
    const folded = fold(safePath)
    const existing = seen.get(folded)
    if (existing !== undefined) {
      throw new ArchiveError(`archive has colliding paths "${existing}" and "${safePath}" (case-insensitive filesystem)`)
    }
    seen.set(folded, safePath)

    if (entry.typeflag === '5') {
      await mkdir(join(options.targetDir, ...safePath.split('/')), { recursive: true })
      summary.dirs += 1
      continue
    }
    if (entry.typeflag === '2') {
      // Symlinks are recorded and skipped: materializing them is unsafe
      // (targets may escape the checkout) and privileged on Windows.
      summary.symlinksSkipped.push(safePath)
      continue
    }
    if (entry.typeflag === '1') {
      const target = writtenFiles.get(fold(entry.linkName))
      if (target === undefined) {
        throw new ArchiveError(`archive hardlink "${safePath}" targets unknown "${entry.linkName}"`)
      }
      const dest = join(options.targetDir, ...safePath.split('/'))
      await mkdir(dirname(dest), { recursive: true })
      await writeFile(dest, await readFile(target))
      summary.hardlinksCopied += 1
      summary.files += 1
      continue
    }

    const data = entry.data
    if (data === undefined) throw new ArchiveError(`archive entry "${safePath}" has no content`)
    totalBytes += data.length
    if (totalBytes > options.maxTotalBytes) {
      throw new ArchiveError(`archive exceeds the ${options.maxTotalBytes}-byte extraction limit`)
    }
    const dest = join(options.targetDir, ...safePath.split('/'))
    await mkdir(dirname(dest), { recursive: true })
    await writeFile(dest, data)
    writtenFiles.set(folded, dest)
    summary.files += 1
    summary.totalBytes = totalBytes
  }
  return summary
}

/** Extract an archive of a detected kind into the target directory. */
export async function extractArchive(kind: ArchiveKind, bytes: Uint8Array, options: ExtractOptions): Promise<ExtractSummary> {
  return kind === 'zip' ? extractZip(bytes, options) : extractTarGz(bytes, options)
}
