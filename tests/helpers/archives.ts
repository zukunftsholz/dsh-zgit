/**
 * Test-only archive builders: small tar.gz / zip writers used to exercise the
 * real extractors. Hand-crafted headers cover pax, GNU long names, zip64-free
 * central directories, symlinks, and hardlinks.
 */

import { crc32, deflateRawSync, gzipSync } from 'node:zlib'

export interface TarFixtureEntry {
  path: string
  kind: 'file' | 'dir' | 'symlink' | 'hardlink'
  content?: string | Uint8Array
  linkName?: string
  /** Emit a pax extended header before this entry with these records. */
  pax?: Record<string, string>
  /** Emit a GNU long-name entry ('L') carrying this path before this entry. */
  longName?: string
}

/** Build one 512-byte ustar header. */
function tarHeader(entry: { name: string; size: number; typeflag: string; linkName?: string; prefix?: string; mode?: string }): Buffer {
  const header = Buffer.alloc(512)
  const write = (offset: number, length: number, value: string): void => {
    header.write(value.slice(0, length), offset, 'utf8')
  }
  write(0, 100, entry.name)
  write(100, 8, entry.mode ?? '0000644\0')
  write(108, 8, '0000000\0')
  write(116, 8, '0000000\0')
  write(124, 12, `${entry.size.toString(8).padStart(11, '0')}\0`)
  write(136, 12, '00000000000\0')
  write(148, 8, '        ')
  write(156, 1, entry.typeflag)
  write(157, 100, entry.linkName ?? '')
  write(257, 6, 'ustar\0')
  write(263, 2, '00')
  write(265, 32, 'root\0')
  write(297, 32, 'root\0')
  write(329, 8, '0000000\0')
  write(337, 8, '0000000\0')
  if (entry.prefix !== undefined) write(345, 155, entry.prefix)
  // checksum: sum of bytes with the checksum field as spaces
  let sum = 0
  for (const byte of header) sum += byte
  header.write(sum.toString(8).padStart(6, '0'), 148, 'ascii')
  header[154] = 0
  header[155] = 0x20
  return header
}

/** Build a tar (uncompressed) from fixture entries. */
export function buildTar(entries: TarFixtureEntry[]): Buffer {
  const chunks: Buffer[] = []
  for (const entry of entries) {
    if (entry.pax !== undefined) {
      const records = Object.entries(entry.pax)
        .map(([key, value]) => paxRecord(key, value))
        .join('')
      const paxBytes = Buffer.from(records, 'utf8')
      chunks.push(tarHeader({ name: 'pax-header', size: paxBytes.length, typeflag: 'x' }))
      chunks.push(paxBytes)
      const padding = paxBytes.length % 512 === 0 ? 0 : 512 - (paxBytes.length % 512)
      chunks.push(Buffer.alloc(padding))
    }
    if (entry.longName !== undefined) {
      const longBytes = Buffer.from(entry.longName, 'utf8')
      chunks.push(tarHeader({ name: '././@LongLink', size: longBytes.length, typeflag: 'L' }))
      chunks.push(longBytes)
      const padding = longBytes.length % 512 === 0 ? 0 : 512 - (longBytes.length % 512)
      chunks.push(Buffer.alloc(padding))
    }
    switch (entry.kind) {
      case 'dir': {
        const name = entry.path.endsWith('/') ? entry.path : `${entry.path}/`
        chunks.push(tarHeader({ name, size: 0, typeflag: '5', mode: '0000755\0' }))
        break
      }
      case 'symlink': {
        chunks.push(tarHeader({ name: entry.path, size: 0, typeflag: '2', linkName: entry.linkName }))
        break
      }
      case 'hardlink': {
        chunks.push(tarHeader({ name: entry.path, size: 0, typeflag: '1', linkName: entry.linkName }))
        break
      }
      case 'file': {
        const data = typeof entry.content === 'string' ? Buffer.from(entry.content, 'utf8') : Buffer.from(entry.content ?? '')
        chunks.push(tarHeader({ name: entry.path, size: data.length, typeflag: '0' }))
        chunks.push(data)
        const padding = data.length % 512 === 0 ? 0 : 512 - (data.length % 512)
        chunks.push(Buffer.alloc(padding))
        break
      }
    }
  }
  chunks.push(Buffer.alloc(1024)) // end-of-archive
  return Buffer.concat(chunks)
}

/** Build a gzipped tar. */
export function buildTarGz(entries: TarFixtureEntry[]): Buffer {
  return gzipSync(buildTar(entries))
}

export interface ZipFixtureEntry {
  path: string
  content?: string | Uint8Array
  dir?: boolean
  method?: 0 | 8
}

/** Build a zip (store or deflate) with correct local + central records. */
export function buildZip(entries: ZipFixtureEntry[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let localOffset = 0

  for (const entry of entries) {
    const name = Buffer.from(entry.path, 'utf8')
    const isDir = entry.dir === true
    const raw = isDir ? Buffer.alloc(0) : Buffer.from(entry.content ?? '')
    const method = isDir ? 0 : (entry.method ?? 8)
    const compressed = method === 8 ? deflateRawSync(raw) : raw
    const crc = crc32(raw)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4) // version needed
    local.writeUInt16LE(0x0800, 6) // UTF-8 names
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(compressed.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    locals.push(local, name, compressed)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4) // version made by
    central.writeUInt16LE(20, 6) // version needed
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(compressed.length, 20)
    central.writeUInt32LE(raw.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt16LE(0, 30) // extra
    central.writeUInt16LE(0, 32) // comment
    central.writeUInt32LE(localOffset, 42) // local header offset
    centrals.push(central, name)
    localOffset += local.length + name.length + compressed.length
  }

  const centralOffset = localOffset
  const centralBytes = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralBytes.length, 12)
  eocd.writeUInt32LE(centralOffset, 16)
  eocd.writeUInt16LE(0, 20)
  return Buffer.concat([...locals, centralBytes, eocd])
}

/** One pax record: `len key=value\n` where len counts itself. */
function paxRecord(key: string, value: string): string {
  const body = `${key}=${value}\n`
  let digits = String(body.length + 1).length
  for (;;) {
    const length = digits + 1 + body.length
    if (String(length).length === digits) return `${length} ${body}`
    digits = String(length).length
  }
}
