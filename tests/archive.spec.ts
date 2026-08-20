import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { detectArchiveKind, extractArchive, sanitizeEntryPath } from '../src/archive.ts'
import { ArchiveError } from '../src/errors.ts'
import { buildTarGz, buildZip } from './helpers/archives.ts'

const tempDirs: string[] = []
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'zgit-test-'))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

const baseOptions = {
  stripRoot: true,
  subdir: undefined as string | undefined,
  maxEntries: 10_000,
  maxTotalBytes: 10 * 1024 * 1024,
}

describe('sanitizeEntryPath', () => {
  it('rejects traversal and absolutes', () => {
    expect(() => sanitizeEntryPath('../evil')).toThrow(ArchiveError)
    expect(() => sanitizeEntryPath('a/../../evil')).toThrow(ArchiveError)
    expect(() => sanitizeEntryPath('/abs')).toThrow(ArchiveError)
    expect(() => sanitizeEntryPath('C:/windows')).toThrow(ArchiveError)
    expect(() => sanitizeEntryPath('a\\..\\evil')).toThrow(ArchiveError)
  })

  it('normalizes backslashes and dots', () => {
    expect(sanitizeEntryPath('a\\b/c')).toBe('a/b/c')
    expect(sanitizeEntryPath('./a/./b')).toBe('a/b')
  })

  it('rejects reserved Windows names', () => {
    expect(() => sanitizeEntryPath('CON')).toThrow(ArchiveError)
    expect(() => sanitizeEntryPath('dir/NUL.txt')).toThrow(ArchiveError)
  })
})

describe('tar.gz extraction', () => {
  it('extracts a git-archive-like tree and strips the root folder', async () => {
    const dir = await tempDir()
    const bytes = buildTarGz([
      { path: 'repo-main/', kind: 'dir' },
      { path: 'repo-main/README.md', kind: 'file', content: '# hi\n' },
      { path: 'repo-main/src/', kind: 'dir' },
      { path: 'repo-main/src/index.js', kind: 'file', content: 'export const x = 1\n' },
      { path: 'repo-main/src/empty.js', kind: 'file', content: '' },
    ])
    expect(detectArchiveKind('https://codeload.github.com/o/r/tar.gz/main', bytes)).toBe('tar.gz')

    const summary = await extractArchive('tar.gz', bytes, { ...baseOptions, targetDir: dir })
    expect(summary.files).toBe(3)
    expect(summary.dirs).toBe(1) // the stripped root folder itself is not counted
    expect(summary.strippedRoot).toBe('repo-main')
    expect(await readFile(join(dir, 'src/index.js'), 'utf8')).toBe('export const x = 1\n')
    expect(await readFile(join(dir, 'README.md'), 'utf8')).toBe('# hi\n')
  })

  it('extracts a subdir only (sparse checkout)', async () => {
    const dir = await tempDir()
    const bytes = buildTarGz([
      { path: 'repo-main/', kind: 'dir' },
      { path: 'repo-main/src/', kind: 'dir' },
      { path: 'repo-main/src/index.js', kind: 'file', content: 'js' },
      { path: 'repo-main/docs/', kind: 'dir' },
      { path: 'repo-main/docs/guide.md', kind: 'file', content: 'md' },
    ])
    const summary = await extractArchive('tar.gz', bytes, { ...baseOptions, targetDir: dir, subdir: 'src' })
    expect(summary.files).toBe(1)
    expect(await readFile(join(dir, 'src/index.js'), 'utf8')).toBe('js')
    await expect(stat(join(dir, 'docs'))).rejects.toThrow()
  })

  it('honors pax long paths (git archive style)', async () => {
    const dir = await tempDir()
    const longPath = `repo-main/${'deep/'.repeat(30)}file.txt`
    const bytes = buildTarGz([
      { path: 'repo-main/', kind: 'dir' },
      { path: 'placeholder', kind: 'file', content: 'content', pax: { path: longPath } },
    ])
    const summary = await extractArchive('tar.gz', bytes, { ...baseOptions, targetDir: dir })
    expect(summary.files).toBe(1)
    expect(await readFile(join(dir, longPath.slice('repo-main/'.length)), 'utf8')).toBe('content')
  })

  it('honors GNU long names', async () => {
    const dir = await tempDir()
    const longPath = `repo-main/${'x/'.repeat(60)}y.txt`
    const bytes = buildTarGz([
      { path: 'repo-main/', kind: 'dir' },
      { path: 'short', kind: 'file', content: 'long content', longName: longPath },
    ])
    const summary = await extractArchive('tar.gz', bytes, { ...baseOptions, targetDir: dir })
    expect(summary.files).toBe(1)
    expect(await readFile(join(dir, longPath.slice('repo-main/'.length)), 'utf8')).toBe('long content')
  })

  it('skips symlinks and copies hardlinks', async () => {
    const dir = await tempDir()
    const bytes = buildTarGz([
      { path: 'repo-main/', kind: 'dir' },
      { path: 'repo-main/original.txt', kind: 'file', content: 'shared' },
      { path: 'repo-main/link.txt', kind: 'hardlink', linkName: 'original.txt' },
      { path: 'repo-main/alias', kind: 'symlink', linkName: 'original.txt' },
    ])
    const summary = await extractArchive('tar.gz', bytes, { ...baseOptions, targetDir: dir })
    expect(summary.hardlinksCopied).toBe(1)
    expect(summary.symlinksSkipped).toEqual(['alias'])
    expect(await readFile(join(dir, 'link.txt'), 'utf8')).toBe('shared')
  })

  it('rejects path traversal inside archives', async () => {
    const dir = await tempDir()
    const bytes = buildTarGz([
      { path: 'repo-main/', kind: 'dir' },
      { path: 'repo-main/../evil.txt', kind: 'file', content: 'boom' },
    ])
    await expect(extractArchive('tar.gz', bytes, { ...baseOptions, targetDir: dir })).rejects.toThrow(/escapes/)
  })

  it('enforces the extraction byte cap', async () => {
    const dir = await tempDir()
    const bytes = buildTarGz([
      { path: 'repo-main/', kind: 'dir' },
      { path: 'repo-main/big.bin', kind: 'file', content: new Uint8Array(4096) },
    ])
    await expect(extractArchive('tar.gz', bytes, { ...baseOptions, targetDir: dir, maxTotalBytes: 1024 })).rejects.toThrow(/limit/)
  })

  it('rejects a truncated tar stream', async () => {
    const dir = await tempDir()
    const bytes = buildTarGz([
      { path: 'repo-main/', kind: 'dir' },
      { path: 'repo-main/a.txt', kind: 'file', content: 'hello world this is long enough to need padding' },
    ])
    // Truncate the last data block.
    const truncated = bytes.slice(0, bytes.length - 300)
    await expect(extractArchive('tar.gz', truncated, { ...baseOptions, targetDir: dir })).rejects.toThrow(/truncated|gzip|invalid/)
  })
})

describe('zip extraction', () => {
  it('extracts deflate and store entries', async () => {
    const dir = await tempDir()
    const bytes = buildZip([
      { path: 'repo-main/', dir: true },
      { path: 'repo-main/README.md', content: '# zip\n' },
      { path: 'repo-main/bin.dat', content: new Uint8Array([1, 2, 3, 4]), method: 0 },
    ])
    expect(detectArchiveKind('https://codeload.github.com/o/r/zip/main', bytes)).toBe('zip')
    const summary = await extractArchive('zip', bytes, { ...baseOptions, targetDir: dir })
    expect(summary.files).toBe(2)
    expect(await readFile(join(dir, 'README.md'), 'utf8')).toBe('# zip\n')
    expect(await readFile(join(dir, 'bin.dat'))).toEqual(Buffer.from([1, 2, 3, 4]))
  })

  it('extracts into a subdir', async () => {
    const dir = await tempDir()
    const bytes = buildZip([
      { path: 'repo-main/', dir: true },
      { path: 'repo-main/src/', dir: true },
      { path: 'repo-main/src/app.js', content: 'app' },
      { path: 'repo-main/docs/', dir: true },
      { path: 'repo-main/docs/x.md', content: 'x' },
    ])
    const summary = await extractArchive('zip', bytes, { ...baseOptions, targetDir: dir, subdir: 'src' })
    expect(summary.files).toBe(1)
    expect(await readFile(join(dir, 'src/app.js'), 'utf8')).toBe('app')
  })

  it('detects corrupted entries by CRC', async () => {
    const dir = await tempDir()
    const bytes = buildZip([
      { path: 'repo-main/', dir: true },
      { path: 'repo-main/a.txt', content: 'original content here' },
    ])
    // Corrupt a byte inside the deflate payload (not the EOCD or headers).
    const flipped = Uint8Array.from(bytes)
    const payloadStart = 30 + 'repo-main/'.length + 30 + 'repo-main/a.txt'.length
    flipped[payloadStart + 3]! ^= 0xff
    await expect(extractArchive('zip', flipped, { ...baseOptions, targetDir: dir })).rejects.toThrow(/CRC|inflate|invalid|malformed/)
  })

  it('rejects traversal in zip names', async () => {
    const dir = await tempDir()
    const bytes = buildZip([
      { path: 'repo-main/', dir: true },
      { path: 'repo-main/../../evil', content: 'no' },
    ])
    await expect(extractArchive('zip', bytes, { ...baseOptions, targetDir: dir })).rejects.toThrow(/escapes/)
  })

  it('rejects colliding case-insensitive paths', async () => {
    const dir = await tempDir()
    const bytes = buildZip([
      { path: 'repo-main/', dir: true },
      { path: 'repo-main/Readme.md', content: 'a' },
      { path: 'repo-main/readme.md', content: 'b' },
    ])
    await expect(extractArchive('zip', bytes, { ...baseOptions, targetDir: dir })).rejects.toThrow(/colliding/)
  })
})

describe('detectArchiveKind', () => {
  it('sniffs magic bytes and extensions', () => {
    expect(detectArchiveKind('https://x/y.zip', new Uint8Array([0x50, 0x4b, 0x03, 0x04]))).toBe('zip')
    expect(detectArchiveKind('https://x/y', new Uint8Array([0x1f, 0x8b]))).toBe('tar.gz')
    expect(detectArchiveKind('https://x/y.tar.gz', new Uint8Array(0))).toBe('tar.gz')
    expect(() => detectArchiveKind('https://x/y', new Uint8Array([1, 2, 3]))).toThrow(/cannot detect/)
  })
})
