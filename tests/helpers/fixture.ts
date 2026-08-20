/**
 * Test-only GitHub fixture: a fetch implementation that serves the API,
 * codeload, and raw endpoints from in-memory fixtures, so core operations can
 * be exercised without the network.
 */

import type { FetchLike } from '../../src/http.ts'

export interface GithubFixture {
  defaultBranch?: string
  branches?: { name: string; commit: { sha: string } }[]
  tags?: { name: string; commit: { sha: string } }[]
  /** commits/{ref} → commit sha; also used for /commits?sha= listings. */
  commits?: Record<string, { sha: string; commit?: { author?: { name?: string; date?: string }; message?: string } }>
  commitList?: { sha: string; commit: { author: { name: string; date: string }; message: string } }[]
  tree?: { truncated?: boolean; tree: { path: string; type: 'blob' | 'tree' | 'submodule'; size?: number }[] }
  compare?: {
    status?: string
    ahead_by?: number
    behind_by?: number
    total_commits?: number
    commits?: { sha: string; commit: { author: { name: string; date: string }; message: string } }[]
    files?: { filename: string; status: string; additions: number; deletions: number; patch?: string }[]
  }
  releases?: {
    latest?: { tag_name: string; name?: string; published_at?: string; assets: { name: string; size: number; browser_download_url: string }[] }
    byTag?: Record<string, { tag_name: string; name?: string; published_at?: string; assets: { name: string; size: number; browser_download_url: string }[] }>
  }
  archiveBytes?: Uint8Array
  rawFiles?: Record<string, string>
}

/** Build a canned GitHub fetch from a fixture. */
export function makeGithubFetch(fixture: GithubFixture): FetchLike {
  const json = (value: unknown, status = 200): Response =>
    new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })

  return async (input, init) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    if (method !== 'GET') return json({ message: 'method not allowed' }, 405)

    // raw.githubusercontent.com/{owner}/{repo}/{ref}/{path...}
    const rawMatch = /^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/.exec(url)
    if (rawMatch !== null) {
      const path = rawMatch[4]!
      const content = fixture.rawFiles?.[path]
      if (content === undefined) return json({ message: 'not found' }, 404)
      return new Response(content, { status: 200, headers: { 'content-type': 'text/plain' } })
    }

    // codeload.github.com/{owner}/{repo}/tar.gz/{ref}
    const codeload = /^https:\/\/codeload\.github\.com\/([^/]+)\/([^/]+)\/(tar\.gz|zip)\/(.+)$/.exec(url)
    if (codeload !== null) {
      if (fixture.archiveBytes === undefined) return json({ message: 'no archive fixture' }, 404)
      return new Response(fixture.archiveBytes, { status: 200, headers: { 'content-type': 'application/gzip' } })
    }

    // api.github.com/...
    const api = /^https:\/\/api\.github\.com(\/.*)$/.exec(url)
    if (api === null) return json({ message: 'unexpected url ' + url }, 500)
    const [pathPart, queryPart] = api[1]!.split('?')
    const path = pathPart!
    const query = new URLSearchParams(queryPart ?? '')

    const repoInfo = /^\/repos\/[^/]+\/[^/]+$/.exec(path)
    if (repoInfo !== null) return json({ default_branch: fixture.defaultBranch ?? 'main', full_name: 'owner/repo' })

    const branches = /^\/repos\/[^/]+\/[^/]+\/branches$/.exec(path)
    if (branches !== null) return json(fixture.branches ?? [])

    const tags = /^\/repos\/[^/]+\/[^/]+\/tags$/.exec(path)
    if (tags !== null) return json(fixture.tags ?? [])

    const commitList = /^\/repos\/[^/]+\/[^/]+\/commits$/.exec(path)
    if (commitList !== null) return json(fixture.commitList ?? [])

    const commit = /^\/repos\/[^/]+\/[^/]+\/commits\/([^/]+)$/.exec(path)
    if (commit !== null) {
      const record = fixture.commits?.[decodeURIComponent(commit[1]!)]
      if (record === undefined) return json({ message: 'Not Found' }, 404)
      return json({ sha: record.sha, commit: record.commit ?? { author: { name: 'tester', date: '2026-01-01T00:00:00Z' }, message: 'commit' } })
    }

    const tree = /^\/repos\/[^/]+\/[^/]+\/git\/trees\/([^/]+)$/.exec(path)
    if (tree !== null) {
      if (fixture.tree === undefined) return json({ message: 'Not Found' }, 404)
      return json(fixture.tree)
    }

    const compare = /^\/repos\/[^/]+\/[^/]+\/compare\/(.+)$/.exec(path)
    if (compare !== null) {
      if (fixture.compare === undefined) return json({ message: 'Not Found' }, 404)
      return json(fixture.compare)
    }

    const releaseLatest = /^\/repos\/[^/]+\/[^/]+\/releases\/latest$/.exec(path)
    if (releaseLatest !== null) {
      if (fixture.releases?.latest === undefined) return json({ message: 'Not Found' }, 404)
      return json(fixture.releases.latest)
    }

    const releaseTag = /^\/repos\/[^/]+\/[^/]+\/releases\/tags\/([^/]+)$/.exec(path)
    if (releaseTag !== null) {
      const release = fixture.releases?.byTag?.[decodeURIComponent(releaseTag[1]!)]
      if (release === undefined) return json({ message: 'Not Found' }, 404)
      return json(release)
    }

    void query
    return json({ message: `no fixture for ${path}` }, 404)
  }
}

/** A canned GitLab fetch for the repository endpoints used by the core. */
export function makeGitlabFetch(fixture: {
  defaultBranch?: string
  project?: Record<string, unknown>
  commits?: Record<string, { id: string }>
  commitList?: { id: string; author_name: string; authored_date: string; title: string }[]
  tree?: { path: string; type: 'blob' | 'tree'; size?: number }[]
  compare?: { commits?: { id: string; title: string }[]; diffs?: { old_path: string; new_path: string; new_file?: boolean; deleted_file?: boolean; diff?: string }[] }
  release?: { tag_name: string; name?: string; released_at?: string; assets: { links?: { name: string; url: string }[]; sources?: { format: string; url: string }[] } }
  releaseList?: { tag_name: string; name?: string; released_at?: string; assets: { links?: { name: string; url: string }[]; sources?: { format: string; url: string }[] } }[]
  archiveBytes?: Uint8Array
  rawFile?: string
}): FetchLike {
  const json = (value: unknown, status = 200): Response =>
    new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })

  return async (input) => {
    const url = String(input)
    const api = /^https:\/\/gitlab\.com\/api\/v4(\/.*)$/.exec(url)
    if (api === null) return json({ message: 'unexpected url ' + url }, 500)
    const path = api[1]!.split('?')[0]!

    const project = /^\/projects\/[^/]+$/.exec(path)
    if (project !== null) return json({ default_branch: fixture.defaultBranch ?? 'main', ...fixture.project })

    const archive = /^\/projects\/[^/]+\/repository\/archive\.tar\.gz$/.exec(path)
    if (archive !== null) {
      if (fixture.archiveBytes === undefined) return json({ message: 'no archive fixture' }, 404)
      return new Response(fixture.archiveBytes, { status: 200, headers: { 'content-type': 'application/gzip' } })
    }

    const raw = /^\/projects\/[^/]+\/repository\/files\/([^/]+)\/raw$/.exec(path)
    if (raw !== null) {
      if (fixture.rawFile === undefined) return json({ message: 'Not Found' }, 404)
      return new Response(fixture.rawFile, { status: 200, headers: { 'content-type': 'text/plain' } })
    }

    const tree = /^\/projects\/[^/]+\/repository\/tree$/.exec(path)
    if (tree !== null) return json(fixture.tree ?? [])

    const commit = /^\/projects\/[^/]+\/repository\/commits\/([^/]+)$/.exec(path)
    if (commit !== null) {
      const record = fixture.commits?.[decodeURIComponent(commit[1]!)]
      if (record === undefined) return json({ message: 'Not Found' }, 404)
      return json({ id: record.id })
    }

    const commitList = /^\/projects\/[^/]+\/repository\/commits$/.exec(path)
    if (commitList !== null) return json(fixture.commitList ?? [])

    const compare = /^\/projects\/[^/]+\/repository\/compare$/.exec(path)
    if (compare !== null) {
      if (fixture.compare === undefined) return json({ message: 'Not Found' }, 404)
      return json(fixture.compare)
    }

    const release = /^\/projects\/[^/]+\/releases\/([^/]+)$/.exec(path)
    if (release !== null) {
      const record = fixture.release
      if (record === undefined) return json({ message: 'Not Found' }, 404)
      return json(record)
    }

    const releaseList = /^\/projects\/[^/]+\/releases$/.exec(path)
    if (releaseList !== null) return json(fixture.releaseList ?? [])

    return json({ message: `no fixture for ${path}` }, 404)
  }
}
