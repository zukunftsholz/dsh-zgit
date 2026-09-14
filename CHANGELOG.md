# Changelog

All notable changes to this project are documented in this file.

## [0.2.0] - 2026-09-14

### Changed

- Adapted to DeepSeek Harness **0.1.5-rc.2** (cordis 4.0.2, schemastery 3.18.2):
  peer floors raised, tool/command/system-prompt integration re-verified. No
  breaking host API was used, so no code changes were required.
- System-prompt guidance now positions zgit against the default-enabled
  `web_fetch` tool: zgit for repository content (archives, releases, raw
  files) written into the workspace, `web_fetch` for plain web pages.
- Default User-Agent bumped to `dsh-zgit/0.2.0`.

### Added

- **SSRF guard** — `zgit_download` and every HTTP fetch refuse private,
  loopback, link-local, and cloud-metadata hosts, re-checked after redirects;
  only `http(s)` URLs are accepted. Local-loopback archive/raw/download
  targets used by self-hosted forges and tests remain reachable through the
  internal `allowPrivate` path.
- **Header-aware rate-limit detection** — `HttpError` carries response
  headers; a 403 counts as rate-limited when `x-ratelimit-remaining: 0` or a
  `retry-after` is present, falling back to the message heuristic only when
  headers are absent.

### Fixed

- MIT LICENSE attribution corrected to the actual author.
- Git-based installs now build on install — a `prepare` script runs the
  portable build, so `dsh plugin add github:zukunftsholz/dsh-zgit` produces
  the gitignored `lib/` through pnpm's prepare step. If pnpm blocks the
  build script, allowlist the exact key it prints under `allowBuilds` in the
  profile's `pnpm-workspace.yaml` and re-run.
- `node scripts/build.mjs` no longer exits with a broken shell's code when
  bash exists but cannot run (e.g. a sandboxed Git Bash that cannot create
  signal pipes): it warns and falls back to the plain local tsc build, which
  surfaces genuine compile errors itself.
- Install docs now use `github:zukunftsholz/dsh-zgit` — the `@zukunftsholz/...`
  npm spec was never published, so the old command 404'd.

## [0.1.1] - 2026-08-19

### Fixed

- zgit_* tools and the `/zgit` command now write into the **calling session's
  workspace** (`exec.agent.session.header.cwd`) instead of the DSH host
  process's `process.cwd()` (the server launch dir). Downloads, clones, raw
  saves, and release assets land in the agent's project folder; agentless
  callers still fall back to the configured `workspaceRoot`.
- `zgit_status` resolves checkouts against the same per-call workspace, so a
  clone made by one session is found by that session's own status checks.

### Changed

- `CallOptions` gains a `workspaceRoot` override; `/zgit` threads the calling
  agent's session cwd through the same path.
- Default User-Agent bumped to `dsh-zgit/0.1.1`.

## [0.1.0] - 2026-08-15

### Added

- Simulated git over plain HTTPS: `zgit_clone` (source archives with
  `.zerogit` metadata, sparse `subdir` extraction, explicit archive URLs),
  `zgit_fetch_release` (release assets with sha256 verification),
  `zgit_show`, `zgit_ls_tree`, `zgit_log`, `zgit_diff`, `zgit_status`,
  `zgit_ls_remote`, `zgit_download`.
- `/zgit` human command for the command plane.
- Archive hardening: path-traversal rejection, entry/byte caps, gzip bomb
  guard, CRC32 for zip, symlink skip + hardlink copy.
- Zero runtime dependencies (Node built-ins only).
